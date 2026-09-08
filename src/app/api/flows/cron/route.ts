import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { DEFAULT_NUDGE_TEXT, shouldSendCollectAiNudge } from '@/lib/flows/engine'
import { engineSendText } from '@/lib/flows/meta-send'
import type { CollectAiNodeConfig } from '@/lib/flows/types'

/**
 * Sweep abandoned active flow runs, and nudge collect_ai runs that
 * have gone quiet before they reach that point.
 *
 * Two independent jobs share this one scan of active runs:
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
 *      is `collect_ai` with `nudge_after_minutes` configured, sends
 *      `nudge_text` (or the built-in default) once per silence period —
 *      see `shouldSendCollectAiNudge` (engine.ts) for the exact
 *      decision, including why a nudge doesn't permanently block a
 *      later one. Skipped entirely when the contact has opted out
 *      (`contacts.ai_nudge_opt_out` — set by the webhook's
 *      `flagNudgeOptOutIfRequested`, checked here, never here itself).
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
 * finer granularity than that.
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
  if (!runs?.length) return NextResponse.json({ swept: 0, nudged: 0 })

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

    if (await maybeSendCollectAiNudge(admin, r, ageHours * 60, now)) {
      nudged += 1
    }
  }

  return NextResponse.json({ swept, nudged })
}

/**
 * Check + fire one collect_ai inactivity nudge for a single active
 * run, when eligible. Returns whether it actually sent one.
 *
 * Looks up the run's CURRENT node by (flow_id, current_node_key) —
 * not a real FK (`node_key` is a stable string, not flow_nodes.id — see
 * types.ts), so this is a separate query per run rather than something
 * the outer `.select()` can embed. Fine at the scale this endpoint
 * already assumes ("small set of active runs per tenant").
 */
async function maybeSendCollectAiNudge(
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
  if (nodeErr || !node || node.node_type !== 'collect_ai') return false

  const cfg = node.config as CollectAiNodeConfig
  if (!cfg.nudge_after_minutes) return false

  const contactsField = Array.isArray(run.contacts) ? run.contacts[0] : run.contacts
  const optedOut = contactsField?.ai_nudge_opt_out ?? false

  const decision = shouldSendCollectAiNudge({
    ageMinutes,
    nudgeAfterMinutes: cfg.nudge_after_minutes,
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
    payload: { node_type: 'collect_ai', nudge: true, age_minutes: Math.round(ageMinutes) },
  })
  return true
}
