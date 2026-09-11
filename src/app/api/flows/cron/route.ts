import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { DEFAULT_NUDGE_AFTER_MINUTES, DEFAULT_NUDGE_TEXT, shouldSendInactivityNudge } from '@/lib/flows/engine'
import { engineSendText } from '@/lib/flows/meta-send'
import type { CollectAiNodeConfig, SendButtonsNodeConfig, SendListNodeConfig } from '@/lib/flows/types'
import { runAutoReplyNow, DEBOUNCE_SWEEP_GRACE_SECONDS } from '@/lib/ai/auto-reply'

/**
 * Sweep abandoned active flow runs, nudge collect_ai runs that have gone
 * quiet before they reach that point, and recover orphaned AI-debounce
 * windows.
 *
 * Three independent jobs share this endpoint (the first two share one scan
 * of active runs; the third scans `conversations` instead):
 *
 *   1. Timeout: reads each active run's parent-flow
 *      `fallback_policy.on_timeout_hours` (default 24h) and marks any
 *      run past its cutoff as `timed_out`. Writes a matching
 *      `flow_run_events` row for the audit trail.
 *
 *      Without this, a customer who abandons a flow mid-conversation
 *      keeps a row in `idx_one_active_run_per_contact` (the partial
 *      unique index on `flow_runs WHERE status='active'`) forever —
 *      blocking any new triggers for them. Not optional.
 *
 *   2. Nudge: for a run still short of the timeout, whose CURRENT node
 *      is `collect_ai`, `send_buttons`, or `send_list` with
 *      `nudge_after_minutes` configured, sends `nudge_text` (or the
 *      built-in default) once per silence period — covers a customer
 *      gone quiet mid-AI-conversation just as much as one who never
 *      tapped a button/list option. See `shouldSendInactivityNudge`
 *      (engine.ts) for the exact decision, including why a nudge
 *      doesn't permanently block a later one. Skipped entirely when
 *      the contact has opted out (`contacts.ai_nudge_opt_out` — set by
 *      the webhook's `flagNudgeOptOutIfRequested`, checked here, never
 *      here itself).
 *
 *   3. Debounce recovery: `dispatchInboundToAiReply` (lib/ai/auto-reply.ts)
 *      debounces a burst of text messages by having the first one's
 *      webhook invocation sleep a few seconds before replying, so it can
 *      answer the whole burst at once. If THAT invocation's serverless
 *      instance dies mid-sleep (rare, but `after()` callbacks aren't
 *      immune to it), the conversation's `ai_debounce_until` is left set
 *      in the future with nobody left to act on it — no later message is
 *      guaranteed to arrive and re-trigger it. This sweep finds any
 *      conversation whose window is older than
 *      `DEBOUNCE_SWEEP_GRACE_SECONDS` (comfortably longer than the
 *      debounce wait + provider-call budget a live owner would still be
 *      inside) and answers it directly via `runAutoReplyNow` — the same
 *      function the debounce wrapper itself calls once its own wait
 *      settles.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger / a native crontab). Pick an interval comfortably shorter
 * than the smallest `nudge_after_minutes` any collect_ai node uses —
 * a 24h-only deployment could get away with hourly, but nudges need
 * finer granularity than that. The debounce-recovery job additionally
 * wants an interval well under `DEBOUNCE_SWEEP_GRACE_SECONDS` (90s
 * today) so an orphaned window doesn't sit unanswered for long — aim
 * for 60s or less.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const now = new Date()

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy and the contact's nudge opt-out flag. Both are
  // real FKs (flow_runs.flow_id -> flows.id, flow_runs.contact_id ->
  // contacts.id) so they come back in the same round trip. The small
  // set of active runs per tenant keeps this cheap.
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, account_id, user_id, contact_id, conversation_id, current_node_key, last_advanced_at, last_nudge_sent_at, flows ( fallback_policy ), contacts ( ai_nudge_opt_out )',
    )
    .eq('status', 'active')

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!runs?.length) {
    const debounceRecovered = await sweepOrphanedDebounceWindows(admin, now)
    return NextResponse.json({ swept: 0, nudged: 0, debounceRecovered })
  }

  type Row = {
    id: string
    flow_id: string
    account_id: string
    user_id: string
    contact_id: string | null
    conversation_id: string | null
    current_node_key: string | null
    last_advanced_at: string
    last_nudge_sent_at: string | null
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
    contacts: { ai_nudge_opt_out: boolean } | { ai_nudge_opt_out: boolean }[] | null
  }

  let swept = 0
  let nudged = 0
  for (const r of runs as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)

    if (ageHours >= policy.on_timeout_hours) {
      // Mark timed_out — guarded by the precondition `status='active'`
      // so concurrent advance from a late inbound doesn't overwrite a
      // legitimate update.
      const { data: updated } = await admin
        .from('flow_runs')
        .update({
          status: 'timed_out',
          ended_at: now.toISOString(),
          end_reason: 'stale_sweep',
        })
        .eq('id', r.id)
        .eq('status', 'active')
        .select('id')

      if (Array.isArray(updated) && updated.length > 0) {
        await admin.from('flow_run_events').insert({
          flow_run_id: r.id,
          event_type: 'timeout',
          payload: {
            age_hours: Math.round(ageHours * 10) / 10,
            policy_hours: policy.on_timeout_hours,
          },
        })
        swept += 1
      }
      continue // timed out (or lost the race) — not nudge-eligible either way
    }

    if (await maybeSendInactivityNudge(admin, r, ageHours * 60, now)) {
      nudged += 1
    }
  }

  const debounceRecovered = await sweepOrphanedDebounceWindows(admin, now)
  return NextResponse.json({ swept, nudged, debounceRecovered })
}

/**
 * Find every conversation whose AI-debounce window (`ai_debounce_until`,
 * migration 058) is older than `DEBOUNCE_SWEEP_GRACE_SECONDS` and answer
 * it directly — recovery path for a debounce "owner" instance that died
 * mid-wait (see this file's own doc comment, job 3, for the full story).
 *
 * The UPDATE...RETURNING below IS the recovery claim: clearing
 * `ai_debounce_until` and deciding "this row is mine to process" happen in
 * the same atomic write, so a concurrent sweep run (overlapping schedules)
 * or a still-alive owner finishing at the same instant loses the race
 * cleanly — its own write/read just doesn't see the row anymore. No
 * separate lock/RPC needed here, unlike `claim_ai_debounce_window`: that
 * one needs the OLD value to decide ownership; this one only needs "was it
 * still set past the cutoff", which a single conditional UPDATE already
 * answers.
 */
async function sweepOrphanedDebounceWindows(
  admin: ReturnType<typeof supabaseAdmin>,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - DEBOUNCE_SWEEP_GRACE_SECONDS * 1000).toISOString()

  const { data: recovered, error } = await admin
    .from('conversations')
    .update({ ai_debounce_until: null })
    .lt('ai_debounce_until', cutoff)
    .select('id, account_id, contact_id')

  if (error) {
    console.error('[flows-cron] debounce sweep query failed:', error.message)
    return 0
  }
  if (!recovered?.length) return 0

  let processed = 0
  for (const conv of recovered as { id: string; account_id: string; contact_id: string }[]) {
    // whatsapp_config is account-scoped and UNIQUE(account_id) (see
    // migration 017 / the ai_configs doc comment) — one row per account.
    const { data: wc } = await admin
      .from('whatsapp_config')
      .select('user_id')
      .eq('account_id', conv.account_id)
      .maybeSingle()
    if (!wc) continue // no WhatsApp config for this account — nothing to send with

    console.warn(
      `[flows-cron] recovering orphaned AI-debounce window for conversation ${conv.id} — an owner instance likely died mid-wait.`,
    )
    await runAutoReplyNow({
      accountId: conv.account_id,
      conversationId: conv.id,
      contactId: conv.contact_id,
      configOwnerUserId: wc.user_id as string,
      isTextMessage: true,
    })
    processed += 1
  }
  return processed
}

/** Node types eligible for an inactivity nudge — anything that can
 *  leave a run parked waiting for the customer's next move. */
const NUDGE_ELIGIBLE_NODE_TYPES = ['collect_ai', 'send_buttons', 'send_list'] as const;

/**
 * Check + fire one inactivity nudge for a single active run, when
 * eligible. Returns whether it actually sent one.
 *
 * Covers three node types that all leave a run parked waiting on the
 * customer: `collect_ai` (waiting on free text for the AI sub-loop),
 * and `send_buttons` / `send_list` (waiting on a tap) — see
 * `NUDGE_ELIGIBLE_NODE_TYPES`. All three read the same
 * `nudge_after_minutes` / `nudge_text` pair off their config
 * (`CollectAiNodeConfig` and the shared `UnmatchedTextHandling` base
 * of the button/list configs respectively — see types.ts), so one
 * function handles all of them instead of duplicating this per type.
 *
 * `collect_ai` stays strictly opt-in (unset `nudge_after_minutes` means
 * no nudge). `send_buttons` / `send_list` are nudge-eligible BY
 * DEFAULT instead: an unset `nudge_after_minutes` falls back to
 * `DEFAULT_NUDGE_AFTER_MINUTES` (engine.ts) so a customer left
 * mid-menu always gets a "¿Sigues ahí?"-style reminder without a
 * builder needing to configure it per node — a node can still set its
 * own minutes, or `0` to opt out entirely.
 *
 * Looks up the run's CURRENT node by (flow_id, current_node_key) —
 * not a real FK (`node_key` is a stable string, not flow_nodes.id — see
 * types.ts), so this is a separate query per run rather than something
 * the outer `.select()` can embed. Fine at the scale this endpoint
 * already assumes ("small set of active runs per tenant").
 */
async function maybeSendInactivityNudge(
  admin: ReturnType<typeof supabaseAdmin>,
  run: {
    id: string
    flow_id: string
    account_id: string
    user_id: string
    contact_id: string | null
    conversation_id: string | null
    current_node_key: string | null
    last_advanced_at: string
    last_nudge_sent_at: string | null
    contacts: { ai_nudge_opt_out: boolean } | { ai_nudge_opt_out: boolean }[] | null
  },
  ageMinutes: number,
  now: Date,
): Promise<boolean> {
  if (!run.current_node_key || !run.contact_id || !run.conversation_id) return false

  const { data: node, error: nodeErr } = await admin
    .from('flow_nodes')
    .select('node_type, config')
    .eq('flow_id', run.flow_id)
    .eq('node_key', run.current_node_key)
    .maybeSingle()
  if (
    nodeErr ||
    !node ||
    !(NUDGE_ELIGIBLE_NODE_TYPES as readonly string[]).includes(node.node_type)
  ) {
    return false
  }

  const cfg = node.config as CollectAiNodeConfig | SendButtonsNodeConfig | SendListNodeConfig
  // collect_ai stays strictly opt-in: unset (undefined) means no nudge
  // at all for that node, unchanged from before this default existed.
  // send_buttons/send_list are nudge-eligible BY DEFAULT: unset falls
  // back to DEFAULT_NUDGE_AFTER_MINUTES so a customer parked on a menu
  // always gets a reminder without per-node setup. `0` (any node type)
  // is an explicit opt-out and must NOT fall back to the default — `??`
  // only substitutes on null/undefined, so it doesn't.
  const nudgeAfterMinutes =
    node.node_type === 'collect_ai'
      ? cfg.nudge_after_minutes
      : (cfg.nudge_after_minutes ?? DEFAULT_NUDGE_AFTER_MINUTES)
  if (!nudgeAfterMinutes) return false

  const contactsField = Array.isArray(run.contacts) ? run.contacts[0] : run.contacts
  const optedOut = contactsField?.ai_nudge_opt_out ?? false

  const decision = shouldSendInactivityNudge({
    ageMinutes,
    nudgeAfterMinutes,
    lastAdvancedAt: run.last_advanced_at,
    lastNudgeSentAt: run.last_nudge_sent_at,
    optedOut,
  })
  if (!decision) return false

  try {
    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id,
      contactId: run.contact_id,
      text: cfg.nudge_text?.trim() || DEFAULT_NUDGE_TEXT,
    })
  } catch (err) {
    console.error('[flows-cron] nudge send failed:', err instanceof Error ? err.message : err)
    return false // don't mark last_nudge_sent_at if the send itself failed
  }

  await admin
    .from('flow_runs')
    .update({ last_nudge_sent_at: now.toISOString() })
    .eq('id', run.id)
  await admin.from('flow_run_events').insert({
    flow_run_id: run.id,
    event_type: 'message_sent',
    node_key: run.current_node_key,
    payload: { node_type: node.node_type, nudge: true, age_minutes: Math.round(ageMinutes) },
  })
  return true
}
