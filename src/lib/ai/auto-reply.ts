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
import { transcribeInboundAudio, type InboundAudioRef } from './inbound-audio'
import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

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
 *  human takes it from here"). */
const AUTO_REPLY_HANDOFF_CLOSING_TEXT = 'Un asesor va a continuar contigo en breve.'

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
 * match.
 */
const AUTO_REPLY_NON_TEXT_FALLBACK_TEXT =
  'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?'

// ============================================================
// Debounce — coalesce a burst of text messages arriving seconds apart
// into a single reply, instead of the general assistant answering each
// one separately. Text-only (see dispatchInboundToAiReply's own
// isTextMessage branch below) — a media inbound keeps going through the
// immediate path unchanged. Design: `conversations.ai_debounce_until`
// (migration 058) plus `claim_ai_debounce_window` is the only safe way
// to read-and-extend that shared timestamp without a race between two
// concurrent webhook deliveries for the same conversation.
// ============================================================

/** Ventana inicial de espera tras el primer mensaje de una posible ráfaga. */
const DEBOUNCE_WINDOW_SECONDS = 6
/** Tope duro: el owner nunca espera más que esto en total, sin importar
 *  cuántos mensajes sigan extendiendo la ventana. */
const MAX_DEBOUNCE_WAIT_SECONDS = 15
/** Tras dejar de esperar, el owner re-extiende ai_debounce_until por esto
 *  ANTES de llamar al modelo — actúa como lock de "procesando" para que un
 *  mensaje que llegue durante la llamada al proveedor no dispare un segundo
 *  owner compitiendo por la misma ráfaga (ver el hueco documentado: un
 *  mensaje que llega DURANTE la llamada al modelo igual se contesta, pero
 *  recién cuando el sweep del cron lo recupera). */
const PROCESSING_LOCK_SECONDS = 30
/** El sweep de /api/flows/cron solo recupera ventanas más viejas que esto —
 *  tiene que ser mayor que MAX_DEBOUNCE_WAIT_SECONDS + PROCESSING_LOCK_SECONDS
 *  para no competir con un owner que sigue vivo y trabajando normalmente. */
export const DEBOUNCE_SWEEP_GRACE_SECONDS = 90

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Sleep until `initialWaitUntil`, then recheck whether a follower message
 * extended the window further — loop until it stabilizes (nobody extended
 * it since the last check) or `MAX_DEBOUNCE_WAIT_SECONDS` total have
 * elapsed since this call started, whichever comes first. No I/O beyond
 * one `conversations` read per iteration; never throws — a read failure
 * just ends the wait early (fail toward answering promptly).
 */
async function waitForDebounceWindowToSettle(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  initialWaitUntil: string,
): Promise<void> {
  const hardDeadline = Date.now() + MAX_DEBOUNCE_WAIT_SECONDS * 1000
  let deadline = new Date(initialWaitUntil).getTime()
  for (;;) {
    const target = Math.min(deadline, hardDeadline)
    const ms = target - Date.now()
    if (ms > 0) await sleep(ms)
    if (Date.now() >= hardDeadline) return // tope duro — se corta acá pase lo que pase
    const { data, error } = await db
      .from('conversations')
      .select('ai_debounce_until')
      .eq('id', conversationId)
      .maybeSingle()
    if (error) return // no bloquear la respuesta por un error de lectura
    const current = data?.ai_debounce_until
      ? new Date(data.ai_debounce_until as string).getTime()
      : 0
    if (current <= Date.now()) return // se estabilizó, nadie extendió de nuevo
    deadline = current // un follower extendió la ventana — dar una vuelta más
  }
}

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
}): Promise<void> {
  try {
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: AUTO_REPLY_HANDOFF_CLOSING_TEXT,
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
    config: AiConfig
    assignedAgentId: string | null
    summary: string
  },
): Promise<void> {
  const update: Record<string, unknown> = {
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
  await sendHandoffClosingMessage(args)
  await markNeedsHuman(db, {
    conversationId: args.conversationId,
    config: args.config,
    assignedAgentId: args.assignedAgentId,
    summary: `🤖 Se alcanzó el límite de ${args.config.autoReplyMaxPerConversation} respuestas automáticas por conversación.`,
  })
}

/**
 * AI auto-reply for a freshly-arrived inbound message — the actual gates
 * + model call + send. Called three ways:
 *   1. Directly by `dispatchInboundToAiReply` below for a non-text inbound
 *      (no debounce — see that function).
 *   2. By `dispatchInboundToAiReply` for a text inbound, AFTER the debounce
 *      wait/recheck loop settles — so `buildConversationContext` (inside
 *      here) sees every message of the burst, not just the one that
 *      triggered this call.
 *   3. By the `/api/flows/cron` debounce sweep, to recover a conversation
 *      whose debounce "owner" instance died mid-wait (see
 *      DEBOUNCE_SWEEP_GRACE_SECONDS) — always with `isTextMessage: true`,
 *      since only text ever goes through debounce in the first place.
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
      documents: config.documents,
    })

    const { text, handoff, sendDocument, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
      documents: config.documents,
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

    // Send a requested document as its own side effect, independent of
    // whether this turn also ends in a handoff — mirrors collect_ai's
    // sendCollectAiDocumentIfRequested (engine.ts). Best-effort: a
    // failed send is logged but never blocks the rest of the turn.
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
        } catch (err) {
          console.error('[ai auto-reply] document send failed:', err)
        }
      }
    }

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
      await sendHandoffClosingMessage({
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
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

    // conv.ai_reply_count still reflects the count BEFORE this reply
    // (claim_ai_reply_slot's increment above only touched the DB row,
    // not this in-memory object) — so `=== 0` correctly means "this is
    // about to be the first reply ever sent in this conversation".
    // Skipped when the model's own text already mentions menú/menu —
    // e.g. the account's business-context system prompt already taught
    // it to say "escribe *menú* para ver las opciones otra vez" — so
    // the customer never sees the hint said twice in one message.
    const mentionsMenuAlready = /men[uú]/i.test(text)
    const outgoingText =
      conv.ai_reply_count === 0 && !mentionsMenuAlready
        ? `${text}${FIRST_REPLY_MENU_HINT}`
        : text

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

/**
 * Public entry point — called by the WhatsApp webhook's `after()` block on
 * every inbound the flow runner did NOT consume. For a non-text inbound
 * this is a thin passthrough to `runAutoReplyNow` (unchanged behavior,
 * zero added latency). For text, it debounces: claims a shared per-
 * conversation window (`claim_ai_debounce_window`, migration 058) so a
 * burst of messages seconds apart gets ONE reply covering all of them
 * instead of one reply per message.
 *
 * Only the first message of a burst ("owner", `is_owner: true`) waits;
 * every later message in the same burst ("follower") just extends the
 * window and returns immediately — it doesn't need to wait itself because
 * its row is already in `messages` by the time the owner's
 * `buildConversationContext` call (inside `runAutoReplyNow`) runs.
 *
 * Never throws — same contract `runAutoReplyNow` already has, and the
 * caller (webhook `after()`) depends on it.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  if (!args.isTextMessage) {
    // No debounce for media — see this module's design note above.
    return runAutoReplyNow(args)
  }

  const db = supabaseAdmin()
  let claimedWindow = false
  try {
    const { data: claimRows, error: claimErr } = await db.rpc(
      'claim_ai_debounce_window',
      {
        p_conversation_id: args.conversationId,
        p_window_seconds: DEBOUNCE_WINDOW_SECONDS,
      },
    )
    if (claimErr) {
      // Same posture as claim_ai_reply_slot's own error handling: almost
      // always a deploy issue (migration not applied / grant missing).
      // Fail OPEN to the immediate path rather than silently dropping the
      // reply — better to answer without debounce than not answer.
      console.error('[ai auto-reply] claim_ai_debounce_window failed:', claimErr)
      return runAutoReplyNow(args)
    }
    const claim = (claimRows as { is_owner: boolean; wait_until: string }[] | null)?.[0]
    if (!claim || !claim.is_owner) return // follower — the owner processes the whole burst
    claimedWindow = true

    await waitForDebounceWindowToSettle(db, args.conversationId, claim.wait_until)

    // Re-extend as a "processing" lock before the (possibly slow)
    // provider call, so a message arriving mid-call doesn't see a settled
    // window and elect itself a second owner for the same burst. See this
    // module's doc comment for the known gap this doesn't fully close.
    await db
      .from('conversations')
      .update({
        ai_debounce_until: new Date(
          Date.now() + PROCESSING_LOCK_SECONDS * 1000,
        ).toISOString(),
      })
      .eq('id', args.conversationId)

    await runAutoReplyNow(args)
  } catch (err) {
    console.error('[ai auto-reply] debounce wrapper failed:', err)
  } finally {
    // Signal "resolved" so the cron sweep never treats a normally-finished
    // window as orphaned — cleared unconditionally (message sent, a gate
    // blocked it, or an error was caught above), but only by whichever
    // call actually became the owner; a follower that returned early never
    // reaches here with `claimedWindow` true, so it can't clobber a window
    // some OTHER, still-active owner is mid-way through.
    if (claimedWindow) {
      await db.from('conversations').update({ ai_debounce_until: null }).eq('id', args.conversationId)
    }
  }
}
