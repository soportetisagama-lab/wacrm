import { supabaseAdmin } from './admin-client'
import type { AiConfig } from './types'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/** Sent to the customer when the per-conversation reply cap is reached
 *  — see handleAutoReplyCapReached below. */
const AUTO_REPLY_CAP_CLOSING_TEXT = 'Un asesor va a continuar contigo en breve.'

/**
 * Mark a conversation as needing a human — pauses auto-reply on it
 * (sticky until re-enabled) and routes to the configured handoff
 * agent (null leaves it in the shared queue, matching the existing
 * `on_conversation_assigned` notification path). Shared by every way
 * `dispatchInboundToAiReply` exits toward a human: the model's own
 * `[[HANDOFF]]` decision, and the two per-conversation reply-cap exits
 * below (the cheap pre-check and the atomic-claim race loss).
 */
async function markNeedsHuman(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    conversationId: string
    config: AiConfig
    assignedAgentId: string | null
    summary: string
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: args.summary,
  }
  // Only set the assignee when a target is configured AND the thread
  // isn't already owned — never stomp an existing human assignment.
  if (args.config.handoffAgentId && !args.assignedAgentId) {
    update.assigned_agent_id = args.config.handoffAgentId
  }
  await db.from('conversations').update(update).eq('id', args.conversationId)
}

/**
 * Reached the per-conversation reply cap (either the cheap pre-check
 * before generating a reply, or lost the atomic-claim race after
 * already generating one) — send a closing line so the customer isn't
 * left with silence, then mark the conversation for a human the same
 * way a model-decided handoff does. The send is wrapped in its own
 * try/catch so a failed send still leaves the conversation correctly
 * marked — the marking matters more than the message landing.
 */
async function handleAutoReplyCapReached(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    config: AiConfig
    assignedAgentId: string | null
  },
): Promise<void> {
  try {
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: AUTO_REPLY_CAP_CLOSING_TEXT,
    })
  } catch (err) {
    console.error('[ai auto-reply] cap-reached closing message send failed:', err)
  }
  await markNeedsHuman(db, {
    conversationId: args.conversationId,
    config: args.config,
    assignedAgentId: args.assignedAgentId,
    summary: `🤖 Se alcanzó el límite de ${args.config.autoReplyMaxPerConversation} respuestas automáticas por conversación.`,
  })
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). Previously a
    // bare `return` here — the customer got silence with no signal
    // anywhere that a human should take over. handleAutoReplyCapReached
    // sends a closing line and marks the conversation the same way a
    // model-decided handoff does; because this returns immediately, a
    // SECOND capped inbound never reaches this line at all — it exits
    // earlier at the `ai_autoreply_disabled` check above, now true —
    // so the closing message only ever sends once per cap event.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      await handleAutoReplyCapReached(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
        assignedAgentId: conv.assigned_agent_id,
      })
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. Assigning (inside
      // markNeedsHuman) fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      await markNeedsHuman(db, {
        conversationId,
        config,
        assignedAgentId: conv.assigned_agent_id,
        summary,
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) {
      // Lost the per-conversation cap race — a concurrent inbound took
      // the last slot between our cheap pre-check and this atomic
      // claim. The model's reply is discarded either way; treat it the
      // same as reaching the cap normally rather than leaving the
      // customer with silence.
      await handleAutoReplyCapReached(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
        assignedAgentId: conv.assigned_agent_id,
      })
      return
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
