import { supabaseAdmin } from './admin-client'
import { hasRecentHumanReply } from '@/lib/conversations/human-activity'
import { attentionFields } from '@/lib/conversations/attention'
import { canAssignAgentToConversation } from '@/lib/conversations/assignee-guard'
import { AiError, type AiConfig } from './types'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { loadBusinessInfo } from './business-info'
import { loadLineTransferContext } from '@/lib/line-transfer-inbound'
import { loadOutboundTransferContext } from '@/lib/line-transfer-outbound'
import {
  fillBusinessHoursPlaceholders,
  isWithinBusinessHours,
  nextOpeningPhrase,
} from '@/lib/flows/business-hours'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { writeHandoffBrief } from './handoff-brief'
import { logAiUsage } from './usage'
import { loadCustomerMemory } from './learning/memory'
import { loadLearnedRules } from './learning/rules'
import { isAiKeyPaused, isAiOutOfServiceError } from './availability'
import { notifyAdminsAiUnavailable } from './availability-notify'
import { recentUserMessages } from './query'
import { transcribeInboundAudio, type InboundAudioRef } from './inbound-audio'
import {
  DEBOUNCE_SWEEP_GRACE_SECONDS,
  lastBusinessMessageIs,
  runDebounced,
  summarizePendingBurst,
} from './debounce'
import { textOf, type ChatMessage } from './types'
import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import { filterAdvisorPromises } from './advisor-promise'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import {
  askPhoneBeforeHandoff,
  loadContactPhoneState,
  noPhoneGiveUpTextFor,
  phoneStateOf,
  parseAwaitingPhone,
  socialClosingTextFor,
  socialPhoneNote,
  swapHeldMarker,
  type ContactPhoneState,
  type HeldHandoffOptions,
} from './awaiting-phone'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /**
   * False when the inbound that triggered this dispatch was media
   * (image/video/audio/sticker/document) rather than usable text — the
   * webhook still calls this unconditionally so every existing
   * eligibility gate (config on, no competing automation, no human
   * assigned, not already handed off, reply cap) applies uniformly;
   * this only changes what happens once all of those pass. `true` for
   * every other inbound kind this function already handled before this
   * field existed.
   */
  isTextMessage: boolean
  /**
   * Present only when the inbound was itself an audio message (voice
   * note or audio file) — set by the webhook from the raw Meta payload,
   * independent of `isTextMessage` (which stays `false` for audio; this
   * is an additive escape hatch, not a reclassification). Its mere
   * presence is the only signal `dispatchInboundToAiReply` uses to
   * attempt transcription — absent for every other media type.
   */
  audio?: InboundAudioRef
  /**
   * True only when the inbound that triggered this dispatch was itself
   * an image (not a sticker — the webhook sets this from `message.type
   * === 'image'`, which a sticker never matches). Independent of
   * `isTextMessage` (stays `false` for an image), same additive-escape-
   * hatch shape as `audio` — but unlike audio there's no transcription
   * step to run here: piece (b) already persisted the Storage copy
   * synchronously in the webhook before this dispatch ever runs, so
   * this is just the signal to skip the text-only nudge and let
   * `buildConversationContext` (with `includeImages`) pick the row up.
   */
  isImageMessage?: boolean
}

/** Sent to the customer whenever auto-reply hands a conversation off to
 *  a human — whether the model decided on its own ([[HANDOFF]]) or the
 *  per-conversation reply cap was reached. Same text either way: from
 *  the customer's side, the underlying situation is identical ("a
 *  human takes it from here"). After hours it says when an advisor will
 *  actually write (same next-opening phrase as the Flows' after-hours
 *  texts) instead of promising "en breve".
 *
 *  `complaint`: the customer is upset — an apology and no emoji.
 *  `variant`: which wording to use (any integer; the auto-reply picks
 *  one at random so the line doesn't read canned). Default 0. */
export function handoffClosingText(
  now: Date = new Date(),
  opts: { complaint?: boolean; variant?: number } = {},
): string {
  const leads = opts.complaint ? COMPLAINT_CLOSING_LEADS : CLOSING_LEADS
  const n = leads.length
  const lead = leads[(((opts.variant ?? 0) % n) + n) % n]
  if (opts.complaint) {
    return isWithinBusinessHours(now)
      ? `${lead} en breve.`
      : `${lead} ${nextOpeningPhrase(now)}, porque ahora estamos fuera de horario.`
  }
  return isWithinBusinessHours(now)
    ? `${lead} y te escribe por aquí en breve 👍`
    : `${lead} 👍 Ahora estamos fuera de horario, así que te escribe por aquí ${nextOpeningPhrase(now)}.`
}

const CLOSING_LEADS = [
  'Listo, ya le paso tu caso a un asesor del equipo',
  'Perfecto, ya derivé tu consulta a un asesor del equipo',
  'Entendido, un asesor del equipo va a tomar tu caso',
]

const COMPLAINT_CLOSING_LEADS = [
  'Lamento lo ocurrido. Ya le paso tu caso a un asesor del equipo, que te escribe por aquí',
  'Entiendo tu molestia y lo siento. Un asesor del equipo va a revisar tu caso y te escribe por aquí',
]

/** Signs of a complaint or anger in what the customer wrote — picks the
 *  apologetic, emoji-free closing line. Mild impatience ("ya te dije")
 *  deliberately doesn't count. */
const COMPLAINT_RE =
  /queja|reclam|molest|enojad|enfadad|indignad|fastidiad|hart[oa]\b|p[eé]sim|terrible|estafa|nadie (?:me )?(?:responde|contesta|atiende)|no sirve|mal servicio|mala atenci[oó]n|decepcion|inaceptable|denuncia|indecopi|reembolso|devoluci[oó]n|falta de respeto|lleg[oó] (?:roto|rota|mal|da[ñn]ad[oa])/i

export function looksLikeComplaint(messages: ChatMessage[]): boolean {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-3)
    .some((m) => COMPLAINT_RE.test(textOf(m.content)))
}

/**
 * Appended, deterministically (never model-generated), to the assistant's
 * FIRST reply in a conversation (`conv.ai_reply_count === 0`) —
 * regardless of whether that reply happened because the first-inbound
 * classifier (lib/ai/classify-first-inbound.ts) found context and skipped
 * the welcome menu, or because the account simply has no menu flow at
 * all. A deterministic append never depends on the model remembering a
 * system-prompt instruction, which a cheaper/smaller model can drop.
 * Reuses the `reentry_keywords` mechanism already wired into
 * `findEntryFlow` (lib/flows/engine.ts) for the actual "menú" re-match —
 * no new code needed there.
 */
const FIRST_REPLY_MENU_HINT = '\n\nSi quieres ver todas nuestras opciones, escribe menú.'

/**
 * Same wording as collect_ai's DEFAULT_NON_TEXT_REPLY_TEXT
 * (lib/flows/engine.ts) — kept as an independent constant rather than
 * imported across the ai/flows module boundary for a single string
 * the two are free to diverge on later, not because they must always
 * match. Sent once per batch of files (see sendNonTextFallback).
 */
export const AUTO_REPLY_NON_TEXT_FALLBACK_TEXT =
  'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?'

// ============================================================
// Debounce — coalesce a burst of messages arriving seconds apart into a
// single reply (lib/ai/debounce.ts, shared with collect_ai). Media goes
// through it too, so several photos/PDFs in a row get ONE answer (or
// one "Recibí tu archivo" notice), not one per file.
// ============================================================

export { DEBOUNCE_SWEEP_GRACE_SECONDS }

/**
 * Send the fixed "text only" nudge for a media inbound (image/video/
 * audio/sticker/document) — never calls the provider, never claims a
 * reply slot, so it costs nothing and doesn't count toward
 * auto_reply_max_per_conversation. Not a handoff: doesn't touch
 * ai_autoreply_disabled or ai_handoff_summary, since nothing here
 * means a human needs to take over — the customer just needs to type.
 */
async function sendNonTextFallback(args: {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
}): Promise<void> {
  try {
    // Once per batch: the previous file of the same batch already got it.
    if (
      await lastBusinessMessageIs(
        supabaseAdmin(),
        args.conversationId,
        AUTO_REPLY_NON_TEXT_FALLBACK_TEXT,
      )
    ) {
      return
    }
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: AUTO_REPLY_NON_TEXT_FALLBACK_TEXT,
    })
  } catch (err) {
    console.error('[ai auto-reply] non-text fallback send failed:', err)
  }
}

/**
 * Send the fixed handoff-closing line, swallowing any send failure —
 * wrapped here (not inline at each call site) so both callers get the
 * same "marking matters more than the message landing" contract
 * without duplicating the try/catch.
 */
async function sendHandoffClosingMessage(args: {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  complaint?: boolean
  /** Replaces the closing line (the no-phone give-up text). */
  text?: string
}): Promise<void> {
  try {
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text:
        args.text ??
        handoffClosingText(new Date(), {
          complaint: args.complaint,
          variant: Math.floor(Math.random() * 6),
        }),
    })
  } catch (err) {
    console.error('[ai auto-reply] handoff closing message send failed:', err)
  }
}

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
    config: Pick<AiConfig, 'handoffAgentId'>
    assignedAgentId: string | null
    summary: string
  },
): Promise<void> {
  // Surface the handed-off chat like a fresh WhatsApp message — top of
  // the inbox + unread badge (see lib/conversations/attention.ts).
  const { data: current } = await db
    .from('conversations')
    .select('unread_count')
    .eq('id', args.conversationId)
    .maybeSingle()
  const update: Record<string, unknown> = {
    ...attentionFields(current?.unread_count),
    // Also mark the thread 'pending' — mirrors markConversationPendingHandoff
    // (lib/flows/engine.ts) so the two independent "this needs a human"
    // signals (Flows' isConversationBotEligible checks `status`; this
    // module only ever checked `ai_autoreply_disabled`) always move
    // together. Without this, a Flow could still start a fresh run over
    // a conversation the general assistant had already handed off,
    // since `status` would still read 'open'.
    status: 'pending',
    ai_autoreply_disabled: true,
    ai_handoff_summary: args.summary,
  }
  // Only set the assignee when a target is configured AND the thread
  // isn't already owned — never stomp an existing human assignment.
  // A Community Manager only owns Messenger/Instagram chats — the DB
  // trigger would reject the whole write, so skip the assignee instead.
  if (
    args.config.handoffAgentId &&
    !args.assignedAgentId &&
    (await canAssignAgentToConversation(db, args.config.handoffAgentId, args.conversationId))
  ) {
    update.assigned_agent_id = args.config.handoffAgentId
  }
  await db.from('conversations').update(update).eq('id', args.conversationId)
}

/**
 * Every auto-reply exit toward a human: the closing line (when
 * `notifyCustomer`), the needs-human mark and the advisor brief. A
 * WhatsApp contact with no phone is never told an advisor writes back:
 * the handoff is put on hold and the customer is asked for the number
 * (./awaiting-phone); the webhook completes it once the number arrives
 * (completeHandoffAwaitingPhone). After MAX_PHONE_ASKS unanswered asks
 * it hands off anyway, with a line that promises no callback.
 *
 * `heldMarker`: acting on a handoff already on hold — the exact marker
 * read. Completing it first swaps that marker away (./awaiting-phone
 * swapHeldMarker); losing that race ('lost') means someone else closed
 * it, so nothing is sent or written.
 */
async function handOffToHuman(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    /** Null-ish config (AI turned off meanwhile) still hands off, without brief. */
    config: AiConfig | null
    assignedAgentId: string | null
    summary: string
    notifyCustomer: boolean
    complaint?: boolean
    /** Write the model-made advisor brief. */
    brief: boolean
    heldMarker?: string | null
    /** A flow handoff's own closing text / assignee (held handoffs). */
    options?: HeldHandoffOptions
  },
): Promise<'handed_off' | 'awaiting_phone' | 'lost'> {
  // Instagram / Messenger: the Community Manager serves these chats first,
  // so the closing never promises an advisor and the note carries the
  // number the customer typed (social contacts have no `phone`).
  const phoneState = await loadContactPhoneState(db, args.contactId)
  const social = phoneState?.social === true
  const phoneNote = socialPhoneNote(phoneState)
  const summary = phoneNote && !args.summary.includes(phoneNote) ? `${args.summary}\n${phoneNote}` : args.summary
  if (args.notifyCustomer) {
    let text: string | undefined
    if (phoneState?.needsPhone) {
      const held = await askPhoneBeforeHandoff(db, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        userId: args.configOwnerUserId,
        summary: args.summary,
        options: args.options,
      })
      if (held === 'asked') return 'awaiting_phone'
      if (held === 'lost') return 'lost'
      text = noPhoneGiveUpTextFor(phoneState)
    } else if (args.heldMarker) {
      if (!(await swapHeldMarker(db, args.conversationId, args.heldMarker, summary))) {
        return 'lost'
      }
      text = social && phoneState ? socialClosingTextFor(phoneState) : heldClosingText(args.options)
    } else if (social && phoneState) {
      text = socialClosingTextFor(phoneState)
    }
    await sendHandoffClosingMessage({
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      configOwnerUserId: args.configOwnerUserId,
      complaint: args.complaint,
      text,
    })
  }
  await markNeedsHuman(db, {
    conversationId: args.conversationId,
    config: { handoffAgentId: args.options?.assignTo ?? args.config?.handoffAgentId ?? null },
    assignedAgentId: args.assignedAgentId,
    summary,
  })
  if (args.brief && args.config) {
    await writeHandoffBrief(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      config: args.config,
      ...(phoneNote ? { appendNote: phoneNote } : {}),
    })
  }
  return 'handed_off'
}

/** The closing text a flow handoff configured (undefined = the default
 *  closing line, which is after-hours aware on its own). */
function heldClosingText(options: HeldHandoffOptions | undefined, now: Date = new Date()): string | undefined {
  if (!options) return undefined
  if (isWithinBusinessHours(now)) return options.closing
  return options.closingAfterHours
    ? fillBusinessHoursPlaceholders(options.closingAfterHours, now)
    : undefined
}

/**
 * The number of a contact whose handoff was on hold (./awaiting-phone)
 * just arrived — called by the webhook after storing the message that
 * carried it. Hands off for real: closing line (the flow's own text when
 * it set one), needs-human mark and the 📋 advisor brief. Returns true
 * when the held handoff was dealt with — by this call or by a concurrent
 * one that won the marker swap — so the caller answers nothing else;
 * false when nothing was on hold, or a human already owns the thread
 * (then only the marker is stripped). Never throws.
 */
export async function completeHandoffAwaitingPhone(args: {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
}): Promise<boolean> {
  try {
    const db = supabaseAdmin()
    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_handoff_summary')
      .eq('id', args.conversationId)
      .maybeSingle()
    const marker = (conv?.ai_handoff_summary as string | null | undefined) ?? null
    const held = parseAwaitingPhone(marker)
    if (!conv || !held || !marker) return false
    if (conv.assigned_agent_id || conv.ai_autoreply_disabled) {
      await swapHeldMarker(db, args.conversationId, marker, held.summary)
      return false
    }
    const config = await loadAiConfig(db, args.accountId)
    await handOffToHuman(db, {
      ...args,
      config,
      assignedAgentId: null,
      summary: held.summary,
      notifyCustomer: true,
      brief: Boolean(config) && !isAiKeyPaused(config?.apiKey ?? ''),
      heldMarker: marker,
      options: held.options,
    })
    return true
  } catch (err) {
    console.error('[ai auto-reply] completing the held handoff failed:', err)
    return false
  }
}


/**
 * Reached the per-conversation reply cap (either the cheap pre-check
 * before generating a reply, or lost the atomic-claim race after
 * already generating one) — send a closing line so the customer isn't
 * left with silence, then mark the conversation for a human the same
 * way a model-decided handoff does.
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
  await handOffToHuman(db, {
    ...args,
    summary: `🤖 Se alcanzó el límite de ${args.config.autoReplyMaxPerConversation} respuestas automáticas por conversación.`,
    notifyCustomer: true,
    brief: true,
  })
}

/**
 * The AI can't answer right now — no credit, rejected key, provider down
 * (see ./availability) — so keep serving the customer without it: the
 * same closing line and human queue as a model-decided handoff. Skipped
 * when the thread is already handed off and still waiting for a human,
 * so a customer writing several messages during an outage doesn't get
 * the closing line again on each one. No advisor brief: writing one
 * needs the provider too.
 */
async function handOffWithoutAi(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    config: AiConfig
    assignedAgentId: string | null
    alreadyHandedOff: boolean
  },
): Promise<void> {
  if (args.alreadyHandedOff) return
  await handOffToHuman(db, {
    ...args,
    // Neutral on purpose — agents see this note; why the AI stopped is
    // for admins only (notifyAdminsAiUnavailable).
    summary: '🤖 El asistente derivó la conversación a un asesor.',
    notifyCustomer: true,
    // Writing the brief needs the provider too.
    brief: false,
  })
}

/** The contact's name when it looks like a real one (not empty, not
 *  just a phone number). Null on any failure — the prompt then omits it. */
function realContactName(row: { name?: unknown } | null): string | null {
  const name = typeof row?.name === 'string' ? row.name.trim() : ''
  return name && /\p{L}/u.test(name) ? name : null
}

/** One contacts read per reply: the name for the prompt and the phone
 *  state for the advisor-promise rule. Nulls on any failure. */
async function loadContactForReply(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<{ name: string | null; phoneState: ContactPhoneState | null }> {
  try {
    const { data, error } = await db.from('contacts').select('*').eq('id', contactId).maybeSingle()
    if (error || !data) return { name: null, phoneState: null }
    return { name: realContactName(data), phoneState: phoneStateOf(data) }
  } catch {
    return { name: null, phoneState: null }
  }
}

/**
 * AI auto-reply for a freshly-arrived inbound message — the actual gates
 * + model call + send. Called two ways:
 *   1. By `dispatchInboundToAiReply` (text and media alike), AFTER the
 *      debounce wait/recheck loop settles — so `buildConversationContext`
 *      (inside here) sees every message of the burst, not just the one
 *      that triggered this call.
 *   2. By the `/api/flows/cron` debounce sweep (runAutoReplyForOrphanedWindow),
 *      to recover a conversation whose debounce "owner" instance died
 *      mid-wait (see DEBOUNCE_SWEEP_GRACE_SECONDS).
 *
 * Mirrors the flow runner's contract: owns its own try/catch and NEVER
 * throws — a failing or slow LLM call must not affect the webhook's 200 to
 * Meta, nor abort the cron sweep's loop over other orphaned conversations.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * A media inbound (image/video/audio/sticker/document — `isTextMessage:
 * false`) that clears all of the above still doesn't reach the model by
 * default: it gets a fixed "text only" nudge instead (sendNonTextFallback),
 * free of provider cost and not counted against the reply cap. Two
 * exceptions fall through to the normal reply path instead: a voice
 * note that transcribes successfully (`transcribeAudioEnabled` +
 * `embeddingsApiKey`), and a live photo when `visionEnabled` is on
 * (`isImageMessage: true` — no transcription step needed, the Storage
 * copy was already persisted by the webhook before this ran).
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function runAutoReplyNow(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    isTextMessage,
    audio,
    isImageMessage,
  } = args

  const turnStartedAt = Date.now()
  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match` /
    // `interactive_reply`) are dispatched independently for this same
    // inbound and may send their own reply, so if the account has any
    // active one we stand down to avoid double-texting the customer.
    // `interactive_reply` included since the webhook now also calls
    // this function for a button/list tap no Flow run was left to
    // consume — an account with BOTH an active interactive_reply
    // automation and general auto-reply enabled must not answer it
    // twice. (Relationship triggers like `first_inbound_message` don't
    // count — they're not per-message auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match', 'interactive_reply'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_handoff_summary')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    // Closed as spam earlier (see handleSpamLoop): stays quiet, no advisor.
    if (conv.ai_autoreply_disabled && conv.ai_handoff_summary?.startsWith(SPAM_SUMMARY_PREFIX)) {
      return
    }
    // …or a human answered by hand in the last 24 h without claiming it.
    if (await hasRecentHumanReply(db, conversationId)) return
    // The same canned reply already went out SPAM_LOOP_REPLIES times in a
    // row (a child sending odd audios, gibberish): close politely, no advisor.
    if (await spamLoopReached(db, conversationId)) {
      await handleSpamLoop(db, { accountId, conversationId, contactId, configOwnerUserId })
      return
    }

    // A handoff on hold for the customer's number (./awaiting-phone): no
    // model call — ask again ("este mismo", "a este número" don't count),
    // hand off if the number is on file by now, or give up after
    // MAX_PHONE_ASKS asks.
    const heldHandoff = parseAwaitingPhone(conv.ai_handoff_summary)
    if (heldHandoff && !conv.ai_autoreply_disabled) {
      await handOffToHuman(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
        assignedAgentId: conv.assigned_agent_id,
        summary: heldHandoff.summary,
        notifyCustomer: true,
        brief: !isAiKeyPaused(config.apiKey),
        heldMarker: conv.ai_handoff_summary,
        options: heldHandoff.options,
      })
      return
    }

    // `ai_autoreply_disabled` alone is no longer sticky forever once
    // nobody has actually claimed the thread (assigned_agent_id null,
    // checked above) — a model-decided handoff or a Flow handoff mid-
    // conversation must not silence the bot permanently if no agent
    // ever picks it up. The one case that must still stay blocked is
    // the reply-cap event itself: `ai_reply_count` stays >= the cap
    // forever (nothing resets it except the manual "Resume AI" action),
    // which is exactly the signal that distinguishes "disabled because
    // the cap was hit" (keep blocking, or handleAutoReplyCapReached
    // below would resend its closing line on every single new message)
    // from "disabled because of a handoff earlier in the conversation,
    // still unclaimed" (should reopen).
    if (conv.ai_autoreply_disabled && conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      return
    }
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
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

    // AI paused for lack of credit (./availability) — hand off right
    // away, before a transcription, knowledge lookup or provider call
    // that would only fail. Back to normal on its own once it resumes.
    if (isAiKeyPaused(config.apiKey)) {
      void notifyAdminsAiUnavailable(db, accountId)
      await handOffWithoutAi(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
        assignedAgentId: conv.assigned_agent_id,
        alreadyHandedOff: Boolean(conv.ai_autoreply_disabled),
      })
      return
    }

    // Media inbound (image/video/audio/sticker/document) — every gate
    // above already passed, so this account/conversation IS eligible
    // for auto-reply right now; it's just that there's no usable text
    // to hand the model. Short-circuits before buildConversationContext
    // /generateReply/claim_ai_reply_slot entirely: no provider call, no
    // reply-cap spend — EXCEPT for the audio-transcription attempt
    // below (only when the account opted in) and the image case (only
    // when vision is on — no attempt needed there, piece (b) already
    // persisted the Storage copy synchronously in the webhook before
    // this dispatch ever ran).
    if (!isTextMessage) {
      let transcript: string | null = null
      // Both flags are required together — an enabled switch with no
      // (or a corrupt) embeddings key is treated the same as disabled,
      // never as an error. Defensive at the data layer: 2c's UI should
      // keep these in sync, but this can't assume it always did.
      if (audio && config.transcribeAudioEnabled && config.embeddingsApiKey) {
        transcript = await transcribeInboundAudio(db, {
          accountId,
          audio,
          embeddingsApiKey: config.embeddingsApiKey,
        })
      }
      // A live inbound photo with vision on falls through to the normal
      // text path below, same as a successfully transcribed voice note
      // — buildConversationContext (with includeImages) picks up the
      // row that's already in the DB rather than this function needing
      // its own copy of the image.
      const visionFallthrough = Boolean(isImageMessage) && config.visionEnabled
      if (transcript === null && !visionFallthrough) {
        await sendNonTextFallback({ accountId, conversationId, contactId, configOwnerUserId })
        return
      }
      // Usable transcript, or a live photo with vision on — fall
      // through to the normal text/vision path below, exactly as if
      // this had arrived as a text message.
    }

    const messages = await buildConversationContext(db, conversationId, undefined, {
      includeImages: config.visionEnabled,
    })
    if (messages.length === 0) return

    // Questions are capped (see forcedHandoffReason): hand off without
    // calling the model.
    const forced = await forcedHandoffReason(db, conversationId, messages)
    if (forced) {
      await handOffToHuman(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
        assignedAgentId: conv.assigned_agent_id,
        summary: buildHandoffSummary({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
        }),
        notifyCustomer: !conv.ai_autoreply_disabled,
        complaint: forced === 'annoyed' || looksLikeComplaint(messages),
        brief: true,
      })
      return
    }

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

    // Ground the reply in the account's knowledge base (best-effort) —
    // queried with the customer's last few messages, not only the last
    // one, so a follow-up ("¿y en acero?") still finds the right excerpt.
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      recentUserMessages(messages, 3),
    )

    // Instagram/Messenger, or WhatsApp without a number: the reply must
    // never promise an advisor (prompt guard + filter before sending).
    const { name: contactName, phoneState } = await loadContactForReply(db, contactId)
    const noAdvisorPromise = Boolean(phoneState && (phoneState.social || phoneState.needsPhone))
    const systemPrompt = buildSystemPrompt({
      noAdvisorPromise,
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      documents: config.documents,
      lineTransferContext: await loadLineTransferContext(db, conversationId, contactId),
      outboundTransferNote: await loadOutboundTransferContext(db, conversationId, contactId),
      contactName,
      now: new Date(),
      customerMemory: await loadCustomerMemory(db, accountId, contactId),
      learnedRules: await loadLearnedRules(db, accountId),
      businessInfo: await loadBusinessInfo(db, accountId),
    })

    // An empty completion (the model spent its whole budget without
    // writing a reply) used to end in silence for the customer — treat
    // it as the handoff it effectively is. Any other provider failure
    // (no credit, rejected key, timeout, outage) also ended in silence —
    // it now hands off without AI.
    const generation = await generateReply({
      config,
      systemPrompt,
      messages,
      documents: config.documents,
    }).catch((err: unknown) => {
      if (err instanceof AiError && err.code === 'empty_response') {
        console.error('[ai auto-reply] empty model response, handing off:', err.message)
        return { text: '', handoff: true, sendDocument: null, usage: null }
      }
      console.error(
        '[ai auto-reply] provider call failed, continuing without AI:',
        err instanceof Error ? err.message : err,
      )
      if (isAiOutOfServiceError(err)) void notifyAdminsAiUnavailable(db, accountId)
      return null
    })
    if (!generation) {
      await handOffWithoutAi(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
        assignedAgentId: conv.assigned_agent_id,
        alreadyHandedOff: Boolean(conv.ai_autoreply_disabled),
      })
      return
    }
    const { text, handoff, sendDocument, usage } = generation

    // The model took a few seconds: if the conversation moved on meanwhile
    // (a menu tap, a flow message or handoff), this answer is stale and
    // would land right before the newer one — drop it.
    if (await conversationMovedOn(db, conversationId, turnStartedAt)) {
      console.log('[ai auto-reply] stale reply dropped, conversation moved on')
      return
    }

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

    // Send a requested document as its own side effect, independent of
    // whether this turn also ends in a handoff — mirrors collect_ai's
    // sendCollectAiDocumentIfRequested (engine.ts). Best-effort: a
    // failed send is logged but never blocks the rest of the turn.
    let documentSent = false
    if (sendDocument) {
      const doc = config.documents.find((d) => d.key === sendDocument)
      // Absent despite parseGeneration's own key check would mean
      // config.documents changed between building the prompt and this
      // call — stale, not a bug to crash over.
      if (doc) {
        try {
          await engineSendMedia({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            kind: doc.media_type,
            link: doc.media_url,
            caption: doc.caption,
            filename: doc.filename,
          })
          documentSent = true
        } catch (err) {
          console.error('[ai auto-reply] document send failed:', err)
        }
      }
    }

    // The model only asked to send a document (no text, no handoff): the
    // file already went out — that's the whole answer, not a handoff.
    if (!handoff && !text && documentSent) return

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. The prompt instructs the
      // model to reply with EXACTLY the [[HANDOFF]] sentinel and
      // nothing else in this case, so `text` is always empty here —
      // without sendHandoffClosingMessage the customer would get no
      // signal at all that a human is taking over. Assigning (inside
      // markNeedsHuman) fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      // Once per handoff: a thread already handed off (and still waiting
      // for an advisor — the bot re-opened only because nobody claimed
      // it) already told the customer an advisor is coming. The advisor
      // brief (details the customer gave) is written after the handoff
      // is committed, so a slow or failed model call never delays it.
      await handOffToHuman(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
        assignedAgentId: conv.assigned_agent_id,
        summary,
        notifyCustomer: !conv.ai_autoreply_disabled,
        complaint: looksLikeComplaint(messages),
        brief: true,
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

    // conv.ai_reply_count still reflects the count BEFORE this reply
    // (claim_ai_reply_slot's increment above only touched the DB row,
    // not this in-memory object) — so `=== 0` correctly means "this is
    // about to be the first reply ever sent in this conversation".
    // Skipped when the model's own text already mentions menú/menu —
    // e.g. the account's business-context system prompt already taught
    // it to say "escribe *menú* para ver las opciones otra vez" — so
    // the customer never sees the hint said twice in one message.
    // Nor when the menu was already sent in this chat — the customer has
    // seen it and answered in their own words.
    let replyText = text
    if (noAdvisorPromise && phoneState) {
      const filtered = filterAdvisorPromises(text, {
        hasPhone: phoneState.social ? Boolean(phoneState.socialPhone) : !phoneState.needsPhone,
      })
      if (filtered.removed.length > 0) {
        console.log(
          `[ai auto-reply] advisor promise filtered (${phoneState.social ? 'social' : 'whatsapp sin número'}) in conversation ${conversationId}: ${filtered.removed.length} sentence(s) removed`,
        )
        replyText = filtered.text
      }
    }
    const mentionsMenuAlready = /men[uú]/i.test(replyText)
    const outgoingText =
      conv.ai_reply_count === 0 && !mentionsMenuAlready && !(await menuAlreadySent(db, conversationId))
        ? `${replyText}${FIRST_REPLY_MENU_HINT}`
        : replyText

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: outgoingText,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/** The same automatic reply this many times in a row means the customer
 *  is not writing anything the assistant can act on. */
const SPAM_LOOP_REPLIES = 3
const SPAM_SUMMARY_PREFIX = '🚫 Posible spam'
const SPAM_CLOSING_TEXT = 'Gracias por tu interés. Este canal es para clientes.'

/** Pure: do the most recent business messages (newest first) end in a run
 *  of `n` identical AI replies? */
export function endsWithRepeatedAiReply(
  recent: { sender_type: string; ai_generated: boolean | null; content_text: string | null }[],
  n: number = SPAM_LOOP_REPLIES,
): boolean {
  const first = recent[0]
  if (!first || first.sender_type === 'customer' || !first.ai_generated || !first.content_text) return false
  let run = 0
  for (const m of recent) {
    if (m.sender_type === 'customer') continue
    if (!m.ai_generated || m.content_text !== first.content_text) break
    run += 1
  }
  return run >= n
}

async function spamLoopReached(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('sender_type, ai_generated, content_text')
      .eq('conversation_id', conversationId)
      .neq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(SPAM_LOOP_REPLIES + 1)
    if (error || !data) return false
    return endsWithRepeatedAiReply(data)
  } catch {
    return false
  }
}

/** One polite closing line, then the assistant stays off — nobody is notified. */
async function handleSpamLoop(
  db: ReturnType<typeof supabaseAdmin>,
  args: { accountId: string; conversationId: string; contactId: string; configOwnerUserId: string },
): Promise<void> {
  try {
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: SPAM_CLOSING_TEXT,
    })
  } catch (err) {
    console.error('[ai auto-reply] spam closing send failed:', err)
  }
  await db
    .from('conversations')
    .update({
      ai_autoreply_disabled: true,
      ai_handoff_summary: `${SPAM_SUMMARY_PREFIX}: el cliente envió mensajes sin contenido y se cerró con un aviso.`,
    })
    .eq('id', args.conversationId)
}

/** Most questions the assistant asks a customer who did not come through the menu. */
const MAX_AI_QUESTIONS = 3

/** The customer is annoyed at being asked things — stop asking, pass to an advisor. */
const ANNOYED_BY_QUESTIONS_RE =
  /no te (?:interesa|importa)|eso no (?:te|le) (?:interesa|importa)|qu[eé] te importa|deja de preguntar|no (?:me )?preguntes|tantas preguntas|no es asunto tuyo|\by punto\b/i

/**
 * Why the assistant must hand off right now regardless of the model:
 * the customer is annoyed by the questions, or it already asked
 * MAX_AI_QUESTIONS in this exchange. Counted since the customer's last
 * button/list tap — chats started from the menu keep their own flow
 * questions. Fails open (null).
 */
async function forcedHandoffReason(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  messages: ChatMessage[],
): Promise<'annoyed' | 'max_questions' | null> {
  const lastUser = messages.filter((m) => m.role === 'user').slice(-2)
  if (lastUser.some((m) => ANNOYED_BY_QUESTIONS_RE.test(textOf(m.content)))) return 'annoyed'
  try {
    let since = Date.now() - 24 * 3600_000
    const { data: tap } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .eq('content_type', 'interactive')
      .gte('created_at', new Date(since).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (tap?.created_at) since = new Date(tap.created_at as string).getTime()
    const { count, error } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('ai_generated', true)
      .like('content_text', '%?%')
      .gte('created_at', new Date(since).toISOString())
    if (error) return null
    return (count ?? 0) >= MAX_AI_QUESTIONS ? 'max_questions' : null
  } catch {
    return null
  }
}

/** True when a menu (interactive bot message) was already sent in this chat. */
async function menuAlreadySent(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<boolean> {
  try {
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'bot')
      .eq('content_type', 'interactive')
    return (count ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * True when something other than a customer's typed text reached this
 * conversation since `sinceMs`: a bot/agent message (flow menu, closing,
 * handoff) or a customer button/list tap. Typed follow-ups are not
 * counted — the debounce reruns the turn for those. Fails open (false).
 */
async function conversationMovedOn(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  sinceMs: number,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('sender_type, content_type')
      .eq('conversation_id', conversationId)
      .gte('created_at', new Date(sinceMs).toISOString())
      .limit(20)
    if (error || !data) return false
    return data.some(
      (m) =>
        m.sender_type !== 'customer' ||
        m.content_type === 'interactive',
    )
  } catch {
    return false
  }
}

/**
 * Public entry point — called by the WhatsApp webhook's `after()` block on
 * every inbound the flow runner did NOT consume. Every inbound (text and
 * media alike) goes through the shared debounce (lib/ai/debounce.ts): a
 * burst of messages seconds apart gets ONE reply covering all of them,
 * and several photos/PDFs in a row get one answer or one notice. A
 * message that arrives while the reply is being written is answered
 * right after it, not dropped.
 *
 * A voice note is transcribed by its own delivery BEFORE joining the
 * burst, so whichever delivery owns the burst already finds the
 * transcript in the conversation.
 *
 * Never throws — the caller (webhook `after()`) depends on it.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  try {
    const db = supabaseAdmin()
    let base: DispatchArgs = args
    if (args.audio) {
      const transcript = await transcribeBeforeBurst(db, args)
      base = { ...args, audio: undefined, isTextMessage: Boolean(transcript) }
    }
    await runDebounced(db, args.conversationId, async ({ rerunSince }) => {
      const next = await argsForPendingBurst(db, base, rerunSince)
      if (next) await runAutoReplyNow(next)
    })
  } catch (err) {
    console.error('[ai auto-reply] debounce wrapper failed:', err)
  }
}

/**
 * Transcribe a voice note before it joins the burst — only when the
 * account opted in and the bot could answer this thread at all (auto-
 * reply on, AI not paused, nobody assigned, reply cap not reached), so
 * a chat the bot won't answer never spends on it.
 */
async function transcribeBeforeBurst(
  db: ReturnType<typeof supabaseAdmin>,
  args: DispatchArgs,
): Promise<string | null> {
  if (!args.audio) return null
  try {
    const config = await loadAiConfig(db, args.accountId)
    if (!config?.autoReplyEnabled || !config.transcribeAudioEnabled || !config.embeddingsApiKey) {
      return null
    }
    if (isAiKeyPaused(config.apiKey)) return null
    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_reply_count')
      .eq('id', args.conversationId)
      .maybeSingle()
    if (conv?.assigned_agent_id) return null
    if ((conv?.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) return null
    return await transcribeInboundAudio(db, {
      accountId: args.accountId,
      audio: args.audio,
      embeddingsApiKey: config.embeddingsApiKey,
    })
  } catch (err) {
    console.error('[ai auto-reply] voice note transcription failed:', err)
    return null
  }
}

/**
 * The owner answers the whole burst, so what kind of answer it gives
 * depends on everything the customer sent since the business last
 * wrote, not only on the message that happened to arrive first: a photo
 * followed by a question is answered as text; three PDFs alone get the
 * file notice. Falls back to `args` when the burst can't be read.
 *
 * On a rerun (`rerunSince` set) `args` describes a message the previous
 * turn already answered, so only what arrived from that turn's start
 * counts — and null (answer nothing) when nothing did, instead of
 * answering the same message twice.
 */
async function argsForPendingBurst(
  db: ReturnType<typeof supabaseAdmin>,
  args: DispatchArgs,
  rerunSince: number | null = null,
): Promise<DispatchArgs | null> {
  if (rerunSince !== null) {
    const burst = await summarizePendingBurst(db, args.conversationId, { since: rerunSince })
    if (!burst) return args
    if (burst.count === 0) return null
    return { ...args, isTextMessage: burst.hasText, isImageMessage: burst.hasImage }
  }
  const burst = await summarizePendingBurst(db, args.conversationId)
  if (!burst) return args
  return {
    ...args,
    isTextMessage: args.isTextMessage || burst.hasText,
    isImageMessage: Boolean(args.isImageMessage) || burst.hasImage,
  }
}

/**
 * Answer, with the general assistant, what the customer sent from
 * `since` on — used by collect_ai (lib/flows/engine.ts) when its run
 * left the node while a message of the burst was still pending: that
 * message was consumed by the flow, so without this nobody answers it.
 * The caller already holds the debounce window. Never throws.
 */
export async function runAutoReplyForPendingBurst(
  args: Omit<DispatchArgs, 'isTextMessage' | 'isImageMessage' | 'audio'>,
  since: number,
): Promise<void> {
  try {
    const next = await argsForPendingBurst(
      supabaseAdmin(),
      { ...args, isTextMessage: true, isImageMessage: false },
      since,
    )
    if (next) await runAutoReplyNow(next)
  } catch (err) {
    console.error('[ai auto-reply] pending burst reply failed:', err)
  }
}

/**
 * Cron-sweep entry (/api/flows/cron): answer a debounce window whose
 * owner instance died mid-wait, or that an owner left set after its last
 * rerun. The sweep doesn't know what the burst held, so it reads it
 * (BurstScope `orphaned`); if it can't, it answers as text (as before);
 * if nothing is pending, it does nothing.
 */
export async function runAutoReplyForOrphanedWindow(
  args: Omit<DispatchArgs, 'isTextMessage' | 'isImageMessage' | 'audio'>,
): Promise<void> {
  const burst = await summarizePendingBurst(supabaseAdmin(), args.conversationId, { orphaned: true })
  if (burst && burst.count === 0) return
  await runAutoReplyNow({
    ...args,
    isTextMessage: burst ? burst.hasText : true,
    isImageMessage: burst?.hasImage ?? false,
  })
}
