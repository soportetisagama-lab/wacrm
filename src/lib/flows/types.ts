/**
 * Type definitions for the Flows runtime.
 *
 * These mirror the Supabase schema added in migration 010 (`flows`,
 * `flow_nodes`, `flow_runs`, `flow_run_events`) plus the discriminated
 * unions the engine uses to typecheck node configs.
 *
 * Schema invariants enforced here that the DB CHECK constraints don't:
 *   - Each node_type maps to one config shape — adding a new node_type
 *     requires adding the matching config interface AND extending
 *     `FlowNodeConfig` so the engine's exhaustiveness checks light up.
 *   - Edges live INSIDE the config (each button row / list row carries
 *     `next_node_key`). The DB schema doesn't model this — the
 *     validator (PR #3) catches missing or orphan edges at save time.
 *
 * `next_node_key` is the stable string id stored in `flow_nodes.node_key`,
 * not a UUID, so flows can be cloned / templated without rewriting
 * references in JSONB.
 */

import type { ExtractionField } from "@/lib/ai/schema";
import type { InboundAudioRef } from "@/lib/ai/inbound-audio";
import type { AiDocument } from "@/lib/ai/types";

// ============================================================
// Node configs (discriminated union by node_type)
// ============================================================

export interface StartNodeConfig {
  /** Stable node_key of the first real node to advance to. */
  next_node_key: string;
}

export interface SendMessageNodeConfig {
  /** Plain text sent to the customer; can interpolate {{vars.X}}. */
  text: string;
  /** Auto-advance target after the message lands at Meta. */
  next_node_key: string;
}

/**
 * Free-text intent detection shared by send_buttons/send_list: the
 * customer typed instead of tapping. Checked BEFORE the flow's
 * generic fallback_policy — if the text contains any of
 * `unmatched_text_keywords` (case-insensitive substring match, same
 * semantics as a flow's `keyword` entry trigger), the run jumps
 * straight to `handoff_node_key`, skipping the reprompt/max_reprompts
 * cycle entirely for that reply. Both fields are optional; when either
 * is unset, free text falls through to fallback_policy exactly as
 * before this existed.
 *
 * `reprompt_hint_text`, separately, is sent as its own plain-text
 * message immediately before fallback_policy's "reprompt" action
 * resends this node's prompt (e.g. "¿Puedes elegir una opción de la
 * lista de arriba?"). Optional; unset means the resend stays silent,
 * matching prior behavior.
 *
 * `text_routes` handles free text that names a DIFFERENT destination
 * than the escalation one above — e.g. "precio"/"cotizar" should jump
 * straight to the quote-collecting node, not to `human_handoff` and
 * not through a generic reprompt. Checked in array order, each entry
 * independent of the others (own keyword list + own match_type,
 * defaulting to "contains" same as `unmatched_text_keywords`); the
 * first entry whose keywords match wins. Checked AFTER
 * `unmatched_text_keywords` (so "quiero hablar con un asesor sobre el
 * precio" still escalates to a human rather than being auto-routed)
 * and BEFORE `release_unmatched_text_to_assistant` (so a configured
 * route always wins over releasing to the general assistant). Optional
 * — unset/empty means no effect, exactly as before this existed.
 */
export interface TextRoute {
  keywords: string[];
  match_type?: "exact" | "contains" | "word";
  node_key: string;
  /**
   * The reply_id of the button/row on THIS SAME node that this route is
   * standing in for — e.g. a "catálogo" text route stands in for the
   * "Catálogo digital" list row. When set, a text match records this
   * reply_id via `record_flow_option_selected` (flow_contact_state,
   * migration 061) exactly as if the customer had tapped that row —
   * so it's correctly excluded from this node's options next time
   * (`sendButtonsAndSuspend`/`sendListAndSuspend`) regardless of
   * whether the customer typed or tapped their way to it. Optional —
   * unset means no option gets recorded, e.g. for a route that doesn't
   * correspond to an existing visible option at all.
   */
  also_marks_selected?: string;
}

/**
 * `release_unmatched_text_to_assistant`, checked AFTER
 * `unmatched_text_keywords` and `text_routes` (both always win first —
 * e.g. "asesor" still escalates to `handoff_node_key`, and a configured
 * `text_routes` match still wins, regardless of this flag): when true,
 * free text that matches none of those ends the run and lets the
 * webhook fall through to the general auto-reply assistant with the
 * SAME inbound message, instead of applying the flow's `fallback_policy`
 * (reprompt/handoff/ignore). The run is ENDED (not left active)
 * specifically so a later message can match an entry trigger again
 * (e.g. a future "menú" keyword flow) — `dispatchInboundToFlows` never
 * even looks at entry triggers while an active run exists. Optional;
 * unset means free text falls through to fallback_policy exactly as
 * before this existed.
 */
interface UnmatchedTextHandling {
  unmatched_text_keywords?: string[];
  handoff_node_key?: string;
  /**
   * Additional keyword → destination routes, checked after the
   * escalation pair above and before `release_unmatched_text_to_assistant`
   * — see the doc comment above `TextRoute` for full precedence.
   */
  text_routes?: TextRoute[];
  reprompt_hint_text?: string;
  /**
   * Overrides `reprompt_hint_text` outside business hours (see
   * `isWithinBusinessHours`) — same precedence idea as
   * HandoffNodeConfig.customer_message_after_hours: a customer typing
   * off-script outside hours still gets to keep navigating the menu
   * (the reprompt itself is unaffected — only this courtesy line
   * changes), rather than being told "fuera de horario" as a dead end.
   * Falls back to `reprompt_hint_text` when unset.
   */
  reprompt_hint_text_after_hours?: string;
  release_unmatched_text_to_assistant?: boolean;
  /**
   * Minutes of inactivity (measured from `flow_runs.last_advanced_at`)
   * before the /api/flows/cron sweep sends `nudge_text` to nudge a
   * customer who went quiet mid-menu.
   *
   * Unlike `CollectAiNodeConfig.nudge_after_minutes` (strictly opt-in),
   * a `send_buttons` / `send_list` node is nudge-eligible BY DEFAULT:
   * leaving this unset applies `DEFAULT_NUDGE_AFTER_MINUTES` (60,
   * engine.ts) automatically, so a customer left staring at a menu
   * always gets a reminder without anyone having to configure it.
   * Set an explicit number of minutes to override the timing, or
   * `0` to opt this node out of nudging entirely. Skipped regardless
   * when the contact has `contacts.ai_nudge_opt_out` set.
   */
  nudge_after_minutes?: number;
  /**
   * Sent when the inactivity nudge fires. Optional — falls back to a
   * built-in default (engine.ts's DEFAULT_NUDGE_TEXT) when
   * `nudge_after_minutes` is set but this isn't.
   */
  nudge_text?: string;
}

export interface SendButtonsNodeConfig extends UnmatchedTextHandling {
  text: string;
  /**
   * Sent instead of `text` when `flow_runs.vars.is_reentry` is true —
   * i.e. this contact has run this flow before (see `insertAndAdvanceRun`,
   * engine.ts). Lets a "Bienvenido a..." style greeting only show the
   * very first time, without repeating the full welcome framing on
   * every later re-trigger. Optional — unset means `text` is always
   * used, exactly as before this existed.
   */
  reentry_text?: string;
  /** Optional header / footer lines around the buttons. */
  header_text?: string;
  footer_text?: string;
  /** 1-3 buttons; Meta cap enforced in meta-api validation. */
  buttons: Array<{
    /** Stable id sent back by Meta when this button is tapped. */
    reply_id: string;
    /** Visible label (≤ 20 chars per Meta). */
    title: string;
    /** node_key the runner advances to when this button is tapped. */
    next_node_key: string;
  }>;
  /**
   * Where to advance instead of sending this node, once THIS contact
   * has already picked every single button here in some prior turn
   * (tracked per contact in `flow_contact_state`, migration 061 — see
   * `sendButtonsAndSuspend`). Never sends an empty/all-hidden message.
   * Unset means no filtering happens at all — every button always
   * shows, exactly as before this existed.
   */
  all_selected_node_key?: string;
}

export interface SendListNodeConfig extends UnmatchedTextHandling {
  text: string;
  /** Same purpose as SendButtonsNodeConfig.reentry_text — see there. */
  reentry_text?: string;
  /** Label of the tap-to-expand button on the message bubble. */
  button_label: string;
  header_text?: string;
  footer_text?: string;
  /** 1-10 rows TOTAL across sections; cap enforced in meta-api. */
  sections: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
  /** Same purpose as SendButtonsNodeConfig.all_selected_node_key — see
   *  there. Checked across every row in every section combined. */
  all_selected_node_key?: string;
}

/**
 * Sends a single image / video / document via WhatsApp, then
 * auto-advances. The media file is uploaded to the `flow-media`
 * Supabase Storage bucket by the builder; `media_url` is the public
 * URL Meta fetches at send time.
 *
 * Why one node with a `media_type` discriminator (rather than three
 * separate node types): Meta's send-side payload differs only in the
 * top-level key (`image` / `video` / `document`) and the
 * filename-on-document quirk. Modeling three node types would triple
 * the builder forms, engine cases, and add-menu entries for no
 * meaningful behavioural difference.
 */
export interface SendMediaNodeConfig {
  media_type: "image" | "video" | "document";
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video. Defaults to the file's original name
   * at upload time; the user can edit it.
   */
  filename?: string;
  /** Auto-advance target after the send lands at Meta. */
  next_node_key: string;
}

export interface HandoffNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /**
   * Optional agent user_id to assign on the conversation when this
   * node fires. Leave unset to flip the status without assignment.
   */
  assign_to?: string;
  /**
   * Sent to the customer before the handoff — this node type used to
   * be entirely silent (only wrote DB state), leaving the customer
   * with no signal a human is taking over. Falls back to a fixed
   * default when unset (never silent); see `executeHandoff` (engine.ts).
   */
  customer_message?: string;
  /**
   * Overrides `customer_message` outside business hours (see
   * `isWithinBusinessHours`, lib/flows/business-hours.ts) — same
   * precedence rule as CollectAiNodeConfig.handoff_fallback_text_after_hours:
   * wins over everything else, including `customer_message`, because
   * only a human (or the business-hours config) should decide
   * time-sensitive wording. Falls back to a fixed default when unset.
   */
  customer_message_after_hours?: string;
}

/**
 * Captures the customer's next free-text reply into
 * `flow_runs.vars[var_key]`, then advances.
 *
 * `validation` is enforced by the runner (see
 * `isValidCollectInputValue`, engine.ts): a reply that fails it is
 * treated exactly like an empty reply — no advance, no vars write —
 * and falls through to the flow's normal `fallback_policy` (reprompt
 * up to `max_reprompts`, then `on_exhaust`), with
 * `validation_error_text` used instead of `prompt_text` for the
 * reprompt so the customer gets a specific, more formal "that doesn't
 * look right" message instead of just seeing the original question
 * again verbatim.
 */
export interface CollectInputNodeConfig {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in
   * `flow_runs.vars`. Stable identifier — used by downstream
   * `condition` nodes and `handoff` notes via interpolation.
   */
  var_key: string;
  /**
   * Format the reply must match to be accepted. `"any"` (or unset)
   * accepts any non-empty text — the original v1.5 behavior.
   * `"phone"` requires exactly 9 digits, spaces allowed as visual
   * separators ("987654321" or "987 654 321") — no country code, no
   * dashes; matches how a WhatsApp Business number is written in Peru.
   * `"email"` requires a plausible `x@y.z` shape. `"regex"` tests
   * against `regex` below. See `isValidCollectInputValue` (engine.ts)
   * for the exact rules.
   */
  validation?: "any" | "email" | "phone" | "regex";
  /** Used only when `validation === 'regex'`. A malformed pattern
   *  fails OPEN (accepts the value) rather than blocking every reply
   *  on this node over one bad config. */
  regex?: string;
  /**
   * Sent instead of `prompt_text` when the customer's reply fails
   * `validation` — the more formal "that doesn't look like a valid
   * [phone/email/...]" re-ask. Optional; falls back to a built-in
   * default per `validation` type (engine.ts's
   * `DEFAULT_PHONE_VALIDATION_ERROR_TEXT` and friends) when unset, so
   * a node with `validation` set gets sane behavior without also
   * configuring this. Ignored when `validation` is `"any"`/unset —
   * nothing can fail that check.
   */
  validation_error_text?: string;
  /** Node to advance to after capture. */
  next_node_key: string;
}

/**
 * Runs a multi-turn LLM sub-loop that asks the customer free-text
 * questions until every `required` field in `fields` is captured,
 * asking only about what's still missing each turn (see
 * `lib/ai/schema.ts`'s `buildExtractionPrompt`) — then advances.
 *
 * Reuses `ExtractionField` from `lib/ai/schema` (the exact shape
 * `extractWithReply` consumes) rather than a parallel field-spec type
 * here, so the node config and the AI call it drives can't drift.
 */
export interface CollectAiNodeConfig {
  /**
   * Optional first message sent when the node is entered. When unset,
   * the engine makes one `extractWithReply` call with no known values
   * so the model generates the opening question itself.
   */
  intro_text?: string;
  /**
   * Fields to collect. Each `field.key` becomes `flow_runs.vars[key]`
   * once captured — same var-storage contract as `collect_input`'s
   * `var_key`. At least one field, and at least one `required`
   * (enforced by the validator, not here).
   */
  fields: ExtractionField[];
  /**
   * Business-specific instructions merged into the extraction prompt
   * (e.g. valid categories for a field). Optional.
   */
  system_context?: string;
  /**
   * Cap on `extractWithReply` calls made within this node before the
   * engine forces a handoff instead of continuing to loop. Measured
   * by `flow_runs.ai_turn_count` (migration 044), which is distinct
   * from `reprompt_count` — see that migration's comment for why.
   */
  max_turns: number;
  /**
   * Node to advance to when `max_turns` is hit without completing, or
   * when the model itself signals `handoff: true`. Falls back to the
   * flow's own handoff-on-exhaust behavior when unset.
   */
  handoff_node_key?: string;
  /**
   * Sent instead of calling the model when the customer's reply isn't
   * text — an image, audio, sticker, or video with no caption. The
   * webhook collapses every inbound kind into a single text-shaped
   * message, using an empty string when there's no caption, so this is
   * the only signal the engine has for "the customer sent media, not
   * words." extractWithReply is never invoked for these turns: no
   * provider call, no ai_turn_count spent. Optional — falls back to a
   * built-in default (engine.ts's DEFAULT_NON_TEXT_REPLY_TEXT) when
   * unset, so every node gets sane behavior without configuring this.
   */
  non_text_reply_text?: string;
  /**
   * Message sent to the customer when handing off WITHOUT a courtesy
   * message from the model itself — i.e. every handoff reason except
   * `model_handoff` (provider failure, max_turns exhausted, or an
   * empty/unusable model reply). Without this, those three exits are
   * silent: the run ends but the customer never finds out why the bot
   * stopped answering. Optional for backward compatibility with nodes
   * created before this field existed, but strongly recommended — see
   * the validator's warning when it's unset.
   */
  handoff_fallback_text?: string;
  /**
   * Closing text sent instead of `handoff_fallback_text` (and instead
   * of the model's own courtesy message, if any) when the handoff
   * happens outside business hours (`lib/flows/business-hours.ts`).
   * The model has no clock and must never be the one deciding
   * time-sensitive wording — this is a plain code-level override.
   * Optional; when unset, handoff text selection is unchanged (the
   * model's message, then `handoff_fallback_text`, exactly as before
   * this field existed).
   */
  handoff_fallback_text_after_hours?: string;
  /**
   * Minutes of inactivity (measured from `flow_runs.last_advanced_at`)
   * before the /api/flows/cron sweep sends `nudge_text` to nudge the
   * customer along. Unset (the default) means no nudge behavior at
   * all for this node — opt-in per node, not a global switch. Skipped
   * entirely when the contact has `contacts.ai_nudge_opt_out` set.
   */
  nudge_after_minutes?: number;
  /**
   * Sent when the inactivity nudge fires. Optional — falls back to a
   * built-in default (engine.ts's DEFAULT_NUDGE_TEXT) when
   * `nudge_after_minutes` is set but this isn't.
   */
  nudge_text?: string;
  /**
   * Fixed catalog of documents this node can send mid-conversation
   * (e.g. a price list or a PDF catalog) when the customer asks for
   * one — "Opción B" of the image-vision session's document work.
   * `key` is the stable identifier the model picks via the
   * extraction schema's `send_document` field (see `schema.ts`); it
   * is NOT a `flow_runs.vars` key and is never merged into `vars`.
   * Sending one is a side effect alongside whatever
   * continue/complete/handoff the turn also produces — asking for a
   * catalog doesn't interrupt the field collection. Optional; unset
   * or empty means this node never offers documents (`send_document`
   * is omitted from the schema entirely, so the model is never even
   * given the option). Same shape as `AiConfig.documents`
   * (lib/ai/types.ts) — see that type's doc comment for why the two
   * aren't merged into one shared catalog.
   */
  documents?: AiDocument[];
  /** Node to advance to once every required field is captured. */
  next_node_key: string;
}

export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent";

export type ConditionSubject = "var" | "tag" | "contact_field";

/**
 * Routes the run based on a predicate over the contact's tags,
 * profile fields, or stored vars. Always auto-advances — no Meta
 * call, no customer-side input.
 */
export interface ConditionNodeConfig {
  subject: ConditionSubject;
  /**
   * For `var`: the key in flow_runs.vars.
   * For `tag`: the tag UUID (matched against contact_tags).
   * For `contact_field`: one of 'name' | 'email' | 'phone' | 'company'.
   */
  subject_key: string;
  operator: ConditionOperator;
  /** Compared against `subject` for `equals`/`contains`. Ignored for `present`/`absent`. */
  value?: string;
  /** Node to advance to when the predicate evaluates true. */
  true_next: string;
  /** Node to advance to when it evaluates false. */
  false_next: string;
}

export interface SetTagNodeConfig {
  mode: "add" | "remove";
  /** Tag UUID. The builder picks from the user's existing tags. */
  tag_id: string;
  next_node_key: string;
}

// Terminal nodes carry no config — they just stop the run.
export type EndNodeConfig = Record<string, never>;

/**
 * Total union — every concrete node_type the engine understands (plus
 * `collect_ai`, whose engine support is still being built — see that
 * type's own doc comment). Add new node types here and the engine's
 * switch will flag missing cases via TypeScript's exhaustiveness
 * check.
 *
 * `http_fetch` remains reserved for a future v2: it has neither a
 * config type here nor a validator/engine case, but is already
 * present in `flow_nodes.node_type`'s DB CHECK constraint (migration
 * 010) as a forward-compat placeholder.
 */
export type FlowNodeConfig =
  | { node_type: "start"; config: StartNodeConfig }
  | { node_type: "send_message"; config: SendMessageNodeConfig }
  | { node_type: "send_buttons"; config: SendButtonsNodeConfig }
  | { node_type: "send_list"; config: SendListNodeConfig }
  | { node_type: "send_media"; config: SendMediaNodeConfig }
  | { node_type: "collect_input"; config: CollectInputNodeConfig }
  | { node_type: "collect_ai"; config: CollectAiNodeConfig }
  | { node_type: "condition"; config: ConditionNodeConfig }
  | { node_type: "set_tag"; config: SetTagNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "end"; config: EndNodeConfig };

export type FlowNodeType = FlowNodeConfig["node_type"];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  match_type?: "exact" | "contains" | "word";
  case_sensitive?: boolean;
}

// No knobs in v1 — the trigger has a single semantic. Kept as a type
// alias (not an empty interface) for forward compat without tripping
// the no-empty-object-type lint rule.
export type FirstInboundTriggerConfig = Record<string, never>;

/**
 * Matches ANY inbound text message from a contact with no active
 * flow_run — a superset of `first_inbound_message` (which only
 * matches when it's literally the contact's first-ever message).
 * Lets a flow like an FAQ bot restart (e.g. re-show its menu) after a
 * prior run reached a terminal status, without requiring the contact
 * to type a keyword.
 *
 * Gated the same way every other entry trigger is (see
 * `isConversationBotEligible` in engine.ts): won't match while the
 * contact's conversation is 'pending' or assigned to a human agent —
 * a human already has it, the bot must not interrupt.
 */
export type ReturningMessageTriggerConfig = Record<string, never>;

export type FlowTriggerConfig =
  | { trigger_type: "keyword"; config: KeywordTriggerConfig }
  | { trigger_type: "first_inbound_message"; config: FirstInboundTriggerConfig }
  | { trigger_type: "manual"; config: Record<string, never> }
  | { trigger_type: "returning_message"; config: ReturningMessageTriggerConfig };

// ============================================================
// DB-row shapes (read by the engine via supabaseAdmin)
// ============================================================

export interface FlowRow {
  id: string;
  /** Account tenancy (NOT NULL post-017). The engine looks up active
   *  flows for inbound dispatch using this field. */
  account_id: string;
  /** Author. Used as a default sender-of-record on engine sends and
   *  preserved on flow_runs for log/audit display. */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual" | "returning_message";
  trigger_config:
    | KeywordTriggerConfig
    | FirstInboundTriggerConfig
    | ReturningMessageTriggerConfig
    | Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: FlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  /** Tenancy. Matches flows.account_id; NOT NULL post-017. */
  account_id: string;
  /** Audit. Matches the parent flow.user_id. */
  user_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "failed";
  current_node_key: string | null;
  last_prompt_message_id: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  /** Model calls made inside the run's CURRENT collect_ai node visit.
   *  Reset to 0 on entering a collect_ai node; compared against that
   *  node's config.max_turns (migration 044). Unrelated to
   *  reprompt_count — see that migration's comment for why they're
   *  separate counters. */
  ai_turn_count: number;
  /** Last time /api/flows/cron sent an inactivity nudge for this run's
   *  current node (migration 048) — collect_ai, send_buttons, or
   *  send_list. Null = never nudged (or nudged before the current
   *  silence period started — see shouldSendInactivityNudge). */
  last_nudge_sent_at: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

// ============================================================
// Fallback policy (matches flows.fallback_policy JSONB)
// ============================================================

export interface FlowFallbackPolicy {
  /** What to do when the customer reply doesn't match any option. */
  on_unknown_reply: "reprompt" | "handoff" | "ignore";
  /** Max reprompts before applying `on_exhaust`. */
  max_reprompts: number;
  /** Stale-run sweep cutoff. */
  on_timeout_hours: number;
  /** What to do once max_reprompts has been hit. */
  on_exhaust: "handoff" | "end";
}

export const DEFAULT_FALLBACK_POLICY: FlowFallbackPolicy = {
  on_unknown_reply: "reprompt",
  max_reprompts: 2,
  on_timeout_hours: 24,
  on_exhaust: "handoff",
};

// ============================================================
// Engine input — what `dispatchInboundToFlows` accepts
// ============================================================

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound =
  | {
      kind: "text";
      /** The user's typed message body. */
      text: string;
      /** Meta's `messages[0].id` — used for idempotency. */
      meta_message_id: string;
      /**
       * Present only when this inbound was itself an audio message
       * (voice note or audio file) — `text` is `""` in that case. Set
       * by the webhook from the raw Meta payload; its mere presence is
       * the only signal `handleReplyForActiveRun` uses to attempt a
       * collect_ai transcription instead of going straight to the
       * fixed non-text reply. Mirrors `DispatchArgs.audio` in
       * lib/ai/auto-reply.ts — same shape (`InboundAudioRef`), same
       * data, independent field because the two dispatch paths
       * (Flows vs. the general auto-reply assistant) never both fire
       * for the same inbound.
       */
      audio?: InboundAudioRef;
      /**
       * True only when this inbound was itself an image (not a sticker
       * — the webhook sets this from `message.type === 'image'`, which
       * a sticker never matches) — `text` is `""` in that case. Its
       * mere presence (`true`) is the only signal
       * `handleReplyForActiveRun` uses to let a collect_ai node retry
       * via `handleCollectAiReply` instead of going straight to the
       * fixed non-text reply — no transcription-equivalent step here:
       * piece (b) already persisted the Storage copy synchronously in
       * the webhook before this ever runs. Mirrors
       * `DispatchArgs.isImageMessage` in lib/ai/auto-reply.ts — same
       * data, independent field, same reason as `audio` above (the two
       * dispatch paths never both fire for the same inbound).
       */
      isImageMessage?: boolean;
    }
  | {
      kind: "interactive_reply";
      /** The reply_id of the tapped button or list row. */
      reply_id: string;
      /** The visible title of the tapped option (for logging). */
      reply_title: string;
      meta_message_id: string;
    };

export interface DispatchInboundInput {
  /** Account tenancy key. Drives the lookup of active flows and the
   *  idempotency check for previously-seen inbound message_ids. */
  accountId: string;
  /** Sender-of-record for the bot's outbound prompts on engine
   *  sends. Set by the webhook to the WhatsApp config owner. */
  userId: string;
  contactId: string;
  conversationId: string;
  message: ParsedInbound;
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — null when not consumed. */
  flow_run_id?: string;
  /** For diagnostics. */
  outcome?:
    | "advanced"
    | "started"
    | "completed"
    | "handed_off"
    | "fallback_fired"
    | "duplicate_inbound_ignored"
    | "released_to_assistant"
    | "already_selected_notice"
    | "stale_interactive_notice"
    | "no_match";
}

// ============================================================
// Helpers — exhaustiveness assertions
// ============================================================

/**
 * Throws a typed compile-time error if the switch over a discriminated
 * union forgets a case. Used in the engine's node-type switch.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled node type: ${JSON.stringify(x)}`);
}
