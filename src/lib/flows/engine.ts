/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { isWithinBusinessHours } from "./business-hours";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { loadAiConfig } from "@/lib/ai/config";
import { classifyFirstInboundContext } from "@/lib/ai/classify-first-inbound";
import { buildConversationContext } from "@/lib/ai/context";
import { transcribeInboundAudio, type InboundAudioRef } from "@/lib/ai/inbound-audio";
import { extractWithReply, type ExtractResult } from "@/lib/ai/generate";
import type { ExtractionField } from "@/lib/ai/schema";
import { logAiUsage } from "@/lib/ai/usage";
import {
  type CollectAiNodeConfig,
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type TextRoute,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/** Escape regex metacharacters in a literal string before embedding it
 *  in a RegExp — needles come from user-configured keywords, not from
 *  a fixed literal set, so this can't assume they're regex-safe. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strips combining diacritics after NFD decomposition — "cotización"
 *  and "cotizacion" (customers routinely drop accents on a phone
 *  keyboard) compare equal. Applied on both sides of every keyword
 *  match below regardless of match_type, never for `case_sensitive`
 *  configs (an exact/case-sensitive match should stay exact). */
function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Case-insensitive contains/exact/word match against a list of
 * keywords. Used by the trigger evaluator. Stable enough that the v3
 * builder UI can preview matches by passing canned strings.
 *
 * `match_type: "word"` sits between "exact" (the whole message, and
 * nothing else, must equal the keyword) and "contains" (the keyword
 * anywhere, even mid-word — "menudo" would match "menu"): it matches
 * the keyword as a whole word, bounded by non-letter/digit characters
 * or the start/end of the message. Added for `reentry_keywords`
 * ("menú") — real customer phrasing like "quiero el menú" or
 * "muéstrame el menú" needs to match, which "exact" misses entirely
 * and "contains" would over-match on (e.g. inside an unrelated longer
 * word).
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive
    ? text
    : foldDiacritics(text.toLowerCase());
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive
      ? raw
      : foldDiacritics(raw.toLowerCase());
    if (matchType === "exact") {
      if (haystack === needle) return true;
    } else if (matchType === "word") {
      const re = new RegExp(
        `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?:[^\\p{L}\\p{N}]|$)`,
        "u",
      );
      if (re.test(haystack)) return true;
    } else if (haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * First `text_routes` entry (see TextRoute, types.ts) whose keywords
 * match, or null when there are no routes or none match. Checked in
 * array order so an account can list a more specific route (e.g. an
 * exact "precio catálogo" phrase) before a broader fallback one.
 */
function matchTextRoute(
  routes: TextRoute[] | undefined,
  text: string,
): TextRoute | null {
  if (!routes?.length) return null;
  for (const route of routes) {
    if (!route.node_key || !route.keywords?.length) continue;
    if (
      matchesKeywordTrigger(text, {
        keywords: route.keywords,
        match_type: route.match_type ?? "contains",
      })
    ) {
      return route;
    }
  }
  return null;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input" ||
    node_type === "collect_ai"
  );
}

/**
 * Enforces `CollectInputNodeConfig.validation` — see that field's own
 * doc comment (types.ts) for the full contract. Pure so it's trivially
 * unit-testable without a DB.
 *
 * `"phone"`: a WhatsApp contact whose display shows only a username
 * (WhatsApp's own username feature, not this codebase's) never exposes
 * a real phone number in the webhook payload — this is what lets a
 * node ask for a callback number and actually validate the answer,
 * instead of accepting whatever text comes back. Peru mobile numbers:
 * exactly 9 digits once spaces are stripped ("987654321" or
 * "987 654 321") — no country code, no dashes.
 *
 * `"regex"` with a malformed pattern fails OPEN (accepts the value)
 * rather than blocking every reply on this node over one bad
 * author-configured regex — same "don't let a config mistake take
 * down the flow" convention as e.g. `evaluateConditionPredicate`.
 */
export function isValidCollectInputValue(
  validation: CollectInputNodeConfig["validation"],
  value: string,
  regex?: string,
): boolean {
  switch (validation) {
    case "phone":
      return /^\d{9}$/.test(value.replace(/\s+/g, ""));
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
    case "regex":
      if (!regex) return true;
      try {
        return new RegExp(regex).test(value);
      } catch {
        return true;
      }
    case "any":
    default:
      return true;
  }
}

/** Defaults for CollectInputNodeConfig.validation_error_text, keyed by
 *  `validation` type, when a node doesn't configure its own wording.
 *  See isValidCollectInputValue's doc comment for the exact rules
 *  each one is re-asking for. */
const DEFAULT_PHONE_VALIDATION_ERROR_TEXT =
  "Ese número no parece válido. ¿Podrías escribirlo nuevamente? Debe tener 9 dígitos, por ejemplo: 987654321.";
const DEFAULT_EMAIL_VALIDATION_ERROR_TEXT =
  "Ese correo no parece válido. ¿Podrías escribirlo nuevamente?";
const DEFAULT_REGEX_VALIDATION_ERROR_TEXT =
  "Ese dato no tiene el formato que necesitamos. ¿Podrías escribirlo nuevamente?";

/** Resolve the reprompt text for a collect_input node whose last reply
 *  failed `validation` — the node's own `validation_error_text` when
 *  configured, else the built-in default for its `validation` type. */
function collectInputValidationErrorText(
  cfg: CollectInputNodeConfig,
): string {
  if (cfg.validation_error_text?.trim()) return cfg.validation_error_text.trim();
  switch (cfg.validation) {
    case "phone":
      return DEFAULT_PHONE_VALIDATION_ERROR_TEXT;
    case "email":
      return DEFAULT_EMAIL_VALIDATION_ERROR_TEXT;
    case "regex":
      return DEFAULT_REGEX_VALIDATION_ERROR_TEXT;
    default:
      // "any"/unset never fails validation — this is never reached in
      // practice, but falls back to the normal prompt rather than an
      // empty string if it somehow is.
      return cfg.prompt_text;
  }
}

/**
 * Map a WhatsApp template quick-reply button's display text to the
 * fixed action it should take — hardcoded to b1_no_respuesta's two
 * known buttons, not a general per-template config (see the design
 * discussion that landed this: one template, two buttons, narrow
 * scope on purpose). `null` for any other button text — the webhook
 * caller leaves those untouched rather than guessing.
 */
export function resolveTemplateButtonAction(
  buttonText: string,
): { action: "start_quote" } | { action: "close" } | null {
  const normalized = buttonText.trim().toLowerCase();
  if (normalized === "sí, quiero info" || normalized === "si, quiero info") {
    return { action: "start_quote" };
  }
  if (normalized === "ya no me interesa") {
    return { action: "close" };
  }
  return null;
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Gate on every entry-trigger match (keyword, first_inbound_message,
 * returning_message alike): a flow must never start over a
 * conversation a human has actually CLAIMED (`assigned_agent_id` set).
 *
 * `status === 'pending'` alone does NOT block eligibility — a prior
 * handoff (flow-side or the AI assistant's own) that nobody has picked
 * up yet must not leave the customer stranded with neither a bot nor a
 * human answering. Only a real assignment silences the bot; mirrors
 * the same relaxation on the AI auto-reply side (see the
 * `ai_autoreply_disabled` handling in dispatchInboundToAiReply,
 * lib/ai/auto-reply.ts) so both systems agree on when a conversation
 * is genuinely "owned" by a human. `status` is still meaningful to
 * agents in the inbox UI (a manual triage label) — this just stops
 * treating it as an automation gate.
 *
 * `null` input (conversation lookup failed/missing) defaults to
 * eligible. This mirrors the rest of this file's convention for DB
 * read failures on guard checks (e.g. `loadActiveRunForContact`,
 * `findEntryFlow` itself) — fail toward the flow still running rather
 * than silently going mute for every trigger type on a transient
 * error. The conversation row is expected to already exist by the
 * time the webhook reaches flow dispatch, so a `null` here signals an
 * infra hiccup, not a real "no conversation" state.
 */
export function isConversationBotEligible(
  conversation: { assigned_agent_id: string | null } | null,
): boolean {
  if (!conversation) return true;
  return conversation.assigned_agent_id === null;
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

/** Why a `collect_ai` node exited toward a handoff instead of `next_node_key`. */
export type CollectAiHandoffReason =
  | "provider_error"
  | "model_handoff"
  | "max_turns_exhausted"
  | "empty_reply";

export type CollectAiOutcome =
  | { kind: "handoff"; reason: CollectAiHandoffReason; message?: string }
  | { kind: "complete"; message: string }
  | { kind: "continue"; message: string };

/** True iff every `required` field already has a non-blank string value in `vars`. */
export function collectAiRequiredFieldsPresent(
  fields: ExtractionField[],
  vars: Record<string, unknown>,
): boolean {
  return fields
    .filter((f) => f.required)
    .every((f) => typeof vars[f.key] === "string" && (vars[f.key] as string).trim().length > 0);
}

/**
 * Pure decision for one `collect_ai` turn — no I/O. The caller has
 * already (a) run `extractWithReply` (or gotten `null` on a provider
 * failure) and (b) merged any extracted fields into `vars` and bumped
 * `turnCount`. This just decides what happens next:
 *
 *   - `result === null` (network/timeout/invalid-key/malformed
 *     extraction) → handoff. Never leave the customer waiting on a
 *     failed call.
 *   - The model set `handoff: true` → handoff, forwarding its
 *     `reply_text` as a courtesy message when it gave one.
 *   - `done: true` AND every required field is actually present in
 *     `vars` → complete. (The `vars` check is authoritative, not the
 *     model's self-report alone — a model that says `done` without
 *     having filled every required field doesn't get to end the
 *     loop.)
 *   - `turnCount >= maxTurns` without completing → handoff
 *     (exhausted); this is checked AFTER the just-spent turn, so the
 *     node gets exactly `maxTurns` model calls, not `maxTurns + 1`.
 *   - An empty `reply_text` when not done → handoff. Mirrors
 *     `dispatchInboundToAiReply`'s `if (handoff || !text)` rule: an
 *     unusable reply is treated as an implicit handoff rather than
 *     leaving the customer with silence or an invented canned line.
 *   - Otherwise → continue, asking `reply_text` and staying suspended
 *     on this node.
 */
export function decideCollectAiOutcome(args: {
  result: ExtractResult | null;
  fields: ExtractionField[];
  /** `run.vars` AFTER the caller has already merged this turn's extraction. */
  vars: Record<string, unknown>;
  /** `run.ai_turn_count` AFTER the caller has already incremented it for this call. */
  turnCount: number;
  maxTurns: number;
}): CollectAiOutcome {
  const { result, fields, vars, turnCount, maxTurns } = args;

  if (!result) {
    return { kind: "handoff", reason: "provider_error" };
  }
  if (result.handoff) {
    return {
      kind: "handoff",
      reason: "model_handoff",
      message: result.replyText.trim() || undefined,
    };
  }
  if (result.done && collectAiRequiredFieldsPresent(fields, vars)) {
    return { kind: "complete", message: result.replyText.trim() };
  }
  if (turnCount >= maxTurns) {
    return { kind: "handoff", reason: "max_turns_exhausted" };
  }
  if (!result.replyText.trim()) {
    return { kind: "handoff", reason: "empty_reply" };
  }
  return { kind: "continue", message: result.replyText.trim() };
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Cheap PRE-check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? Cheap in the sense that it avoids loading nodes / touching the
 * run at all for the common case (a Meta retry arriving well after the
 * original was already fully processed). NOT the authoritative guard
 * against a genuine race — two deliveries close enough in time can
 * both read "not found" here before either has written; see
 * `claimReplyReceived` (called unconditionally right after this, from
 * `handleReplyForActiveRun`) for the actual atomic claim that closes
 * that window.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

/**
 * The AUTHORITATIVE duplicate-inbound guard — an atomic claim, not a
 * read. Attempts to INSERT this run's `reply_received` event for this
 * Meta message id; the partial unique index
 * `idx_flow_run_events_reply_dedup` (migration 060) rejects a second
 * concurrent attempt with 23505 (unique_violation). Called
 * unconditionally as the very first thing `handleReplyForActiveRun`
 * does — before any matching, var-capture, advancing, or sending — so
 * a losing concurrent delivery never reaches a customer-facing send at
 * all, unlike the old check-then-act `isDuplicateInbound` alone (kept
 * above as a cheap pre-check, not a replacement for this).
 *
 * Returns `true` when this call genuinely claimed the slot (proceed
 * normally); `false` when a concurrent delivery already claimed it
 * (the caller should stop, treating this as `duplicate_inbound_ignored`).
 * A non-uniqueness error is logged and treated as claimed (fail open —
 * an infra hiccup here must not silently eat a genuine reply).
 */
async function claimReplyReceived(
  db: AdminClient,
  runId: string,
  currentNodeKey: string | null,
  message: ParsedInbound,
): Promise<boolean> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: runId,
    event_type: "reply_received",
    node_key: currentNodeKey,
    payload: {
      meta_message_id: message.meta_message_id,
      reply_kind: message.kind,
      reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
      text_length: message.kind === "text" ? message.text.length : null,
    },
  });
  if (!error) return true;
  const msg = error.message ?? "";
  if (msg.includes("23505") || msg.includes("duplicate key")) {
    return false;
  }
  console.error("[flows] claimReplyReceived insert error:", error.message);
  return true;
}

/**
 * Conversation fields the entry-trigger gate needs. One indexed
 * by-PK lookup — only hit on the "no active run" path, which is
 * already the less-common branch of dispatch.
 */
async function loadConversationGateInfo(
  db: AdminClient,
  conversationId: string,
): Promise<{ assigned_agent_id: string | null } | null> {
  const { data, error } = await db
    .from("conversations")
    .select("assigned_agent_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadConversationGateInfo error:", error.message);
    return null;
  }
  return (data as { assigned_agent_id: string | null } | null) ?? null;
}

/**
 * Per-contact memory across separate flow_runs — see migration 061's
 * own doc comment for the full rationale. Defaults to empty on any
 * miss (no row yet for this contact) or DB error — fail toward "we
 * don't know anything yet", never toward crashing the dispatch.
 */
async function loadFlowContactState(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<{ known_vars: Record<string, unknown>; selected_options: Record<string, string[]> }> {
  const empty = { known_vars: {}, selected_options: {} };
  const { data, error } = await db
    .from("flow_contact_state")
    .select("known_vars, selected_options")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (error || !data) return empty;
  const row = data as { known_vars: unknown; selected_options: unknown };
  return {
    known_vars: (row.known_vars as Record<string, unknown> | null) ?? {},
    selected_options: (row.selected_options as Record<string, string[]> | null) ?? {},
  };
}

/** Best-effort — a failure to persist this contact's captured field
 *  must never block the customer-facing turn that just captured it. */
async function mergeFlowKnownVars(
  db: AdminClient,
  accountId: string,
  contactId: string | null,
  vars: Record<string, unknown>,
): Promise<void> {
  if (!contactId || Object.keys(vars).length === 0) return;
  const { error } = await db.rpc("merge_flow_known_vars", {
    p_account_id: accountId,
    p_contact_id: contactId,
    p_vars: vars,
  });
  if (error) {
    console.error("[flows] merge_flow_known_vars rpc error:", error.message);
  }
}

/** Best-effort — same reasoning as mergeFlowKnownVars above. */
async function recordFlowOptionSelected(
  db: AdminClient,
  accountId: string,
  contactId: string | null,
  nodeKey: string,
  replyId: string,
): Promise<void> {
  if (!contactId) return;
  const { error } = await db.rpc("record_flow_option_selected", {
    p_account_id: accountId,
    p_contact_id: contactId,
    p_node_key: nodeKey,
    p_reply_id: replyId,
  });
  if (error) {
    console.error("[flows] record_flow_option_selected rpc error:", error.message);
  }
}

/**
 * Re-entry keywords ("menú"/"menu") are independent of trigger_type —
 * matched against EVERY active flow's `trigger_config.reentry_keywords`
 * (plain JSONB, no schema change), regardless of that flow's primary
 * trigger_type. Exported as its own function (not just inlined in
 * `findEntryFlow`) because it's also the one thing `dispatchInboundToFlows`
 * checks when the conversation is 'pending' with nobody actually
 * assigned yet — see the design note there for why "menú" specifically
 * is allowed to break through that gate when nothing else is.
 *
 * `match_type: "word"` (not "exact"): real customer phrasing like
 * "quiero el menú" or "muéstrame el menú" needs to match — "exact"
 * only matched a message that was the word and nothing else.
 */
export async function findReentryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
): Promise<FlowRow | null> {
  if (message.kind !== "text") return null;

  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  for (const flow of flows as FlowRow[]) {
    const reentryKeywords = (
      flow.trigger_config as { reentry_keywords?: string[] } | null
    )?.reentry_keywords;
    if (
      reentryKeywords?.length &&
      matchesKeywordTrigger(message.text, {
        keywords: reentryKeywords,
        match_type: "word",
      })
    ) {
      return flow;
    }
  }
  return null;
}

export async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  conversationId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Checked first, before the normal per-trigger_type matching below —
  // see findReentryFlow's own doc comment. Only reached when there's no
  // active flow_run for this contact (dispatchInboundToFlows never
  // calls findEntryFlow otherwise) — a run already in progress (e.g.
  // mid collect_ai) is deliberately left alone; see the design note
  // this implements (Opción A).
  const reentryFlow = await findReentryFlow(db, accountId, message);
  if (reentryFlow) return reentryFlow;

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];

  // Memoized so a message never gets classified twice, even in the
  // unusual case where more than one active flow uses trigger_type
  // "first_inbound_message" — the loop below reuses this one result.
  let firstInboundContext: Awaited<
    ReturnType<typeof classifyFirstInboundContext>
  > | null = null;

  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Menú condicional según contexto: a first-ever message that
      // already states a real request ("Necesito cotizar una cocina
      // para mi restaurante en Trujillo") should reach the general
      // assistant directly instead of being swallowed by the welcome
      // menu. classifyFirstInboundContext NEVER throws and fails open
      // to `hasContext: false` (today's behavior — show the menu) on
      // any error, timeout, or missing AI config.
      if (!firstInboundContext) {
        firstInboundContext = await classifyFirstInboundContext(
          db,
          accountId,
          conversationId,
          message.text,
        );
      }
      if (firstInboundContext.hasContext) {
        // Skip this flow — do NOT return it — so a `keyword`-trigger
        // flow later in this same loop can still match independently.
        // The customer's first message reaches dispatchInboundToAiReply
        // via the "no_match" path back in dispatchInboundToFlows; its
        // deterministic footer (auto-reply.ts) still offers "menú" as
        // an escape hatch, which reentry_keywords (above) picks back up
        // on any later message.
        continue;
      }
      return flow;
    } else if (flow.trigger_type === "returning_message") {
      // Superset of first_inbound_message: matches on ANY text
      // message, not just the contact's first ever. Lets a flow
      // restart (e.g. re-show its menu) after a prior run for this
      // contact reached a terminal status.
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

/** True whenever this send is NOT the very first message of a brand
 *  new conversation with this flow — either a cross-run reentry, or a
 *  reprompt-resend within the current run. Drives reentry_text
 *  selection (see SendButtonsNodeConfig/SendListNodeConfig's own doc
 *  comments) so a "Bienvenido..." framing never repeats. */
function isNotTheFirstShow(run: FlowRunRow): boolean {
  return run.vars.is_reentry === true || run.reprompt_count > 0;
}

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced" | "redirect"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const bodyText =
    isNotTheFirstShow(run) && cfg.reentry_text?.trim() ? cfg.reentry_text : cfg.text;

  // Filter out any button this contact already picked on THIS node in
  // a prior turn (flow_contact_state, migration 061) — the customer
  // never sees an option twice. Falls back to showing everything
  // unfiltered if that would leave zero buttons and no redirect target
  // is configured — never silently sends nothing.
  const contactState = await loadFlowContactState(db, run.account_id, run.contact_id!);
  const alreadySelected = new Set(contactState.selected_options[node.node_key] ?? []);
  const visibleButtons = cfg.buttons.filter((b) => !alreadySelected.has(b.reply_id));
  if (visibleButtons.length === 0) {
    if (cfg.all_selected_node_key) {
      return { outcome: "redirect", node_key: cfg.all_selected_node_key };
    }
    visibleButtons.push(...cfg.buttons);
  }

  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: visibleButtons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced" | "redirect"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const bodyText =
    isNotTheFirstShow(run) && cfg.reentry_text?.trim() ? cfg.reentry_text : cfg.text;

  // Same filtering as sendButtonsAndSuspend — see its own comment.
  // Sections that end up with zero rows are dropped entirely (Meta
  // rejects an empty section); "all selected" means every row across
  // every section is gone, not just one section.
  const contactState = await loadFlowContactState(db, run.account_id, run.contact_id!);
  const alreadySelected = new Set(contactState.selected_options[node.node_key] ?? []);
  let visibleSections = cfg.sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => !alreadySelected.has(r.reply_id)) }))
    .filter((s) => s.rows.length > 0);
  if (visibleSections.length === 0) {
    if (cfg.all_selected_node_key) {
      return { outcome: "redirect", node_key: cfg.all_selected_node_key };
    }
    visibleSections = cfg.sections;
  }

  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: visibleSections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

// ============================================================
// collect_ai node — a multi-turn LLM sub-loop that fills `fields`
// from free-text conversation, asking only about what's still
// missing, then advances. See CollectAiNodeConfig's doc comment
// (types.ts) and `decideCollectAiOutcome` above for the full contract.
// ============================================================

/** Default for CollectAiNodeConfig.non_text_reply_text when a node
 *  doesn't configure one. */
const DEFAULT_NON_TEXT_REPLY_TEXT =
  "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?";

/** Default for CollectAiNodeConfig.nudge_text / UnmatchedTextHandling.nudge_text
 *  when a node is nudge-eligible but doesn't configure its own wording.
 *  Sent by the /api/flows/cron sweep, not by the engine itself. */
export const DEFAULT_NUDGE_TEXT =
  "¿Sigues ahí? Quedé esperando tu respuesta para poder continuar con tu consulta.";

/**
 * Default silence window (minutes) applied to a `send_buttons` /
 * `send_list` node that doesn't set `nudge_after_minutes` explicitly —
 * see the cron route's `maybeSendInactivityNudge`. Unlike `collect_ai`
 * (still strictly opt-in: unset means no nudge at all), a customer
 * parked on a menu gets this nudge automatically so nobody has to
 * remember to configure it per node. A node can still override the
 * timing, or set `nudge_after_minutes: 0` to opt out entirely.
 */
export const DEFAULT_NUDGE_AFTER_MINUTES = 60;

/** Default for HandoffNodeConfig.customer_message when a `handoff` node
 *  doesn't configure one, and for the generic fallback_policy "handoff"
 *  exit (no node config to read there at all) — see `executeHandoff`
 *  and the `action.type === "handoff"` branch in `handleReplyForActiveRun`.
 *  Both used to be completely silent to the customer. */
const DEFAULT_HANDOFF_CUSTOMER_MESSAGE =
  "Gracias, un asesor va a continuar tu consulta en breve.";

/** Default for HandoffNodeConfig.customer_message_after_hours, and for
 *  the generic fallback_policy "handoff" exit outside business hours —
 *  same idea as DEFAULT_HANDOFF_CUSTOMER_MESSAGE, but for when nobody
 *  is actually working right now. */
const DEFAULT_HANDOFF_CUSTOMER_MESSAGE_AFTER_HOURS =
  "Gracias por escribirnos. En este momento estamos fuera de nuestro horario de atención — un asesor se pondrá en contacto contigo apenas estemos disponibles nuevamente.";

/** Sent when a customer taps a button/list row from a STALE message —
 *  no active run exists for them anymore (it already completed or
 *  handed off), but flow_contact_state shows this exact reply_id was
 *  already resolved in some earlier run. Typically happens when the
 *  customer scrolls up in WhatsApp and re-taps an old option. Ends the
 *  dead end honestly instead of either silently doing nothing or
 *  letting the general assistant re-process it as a brand new request
 *  it has no context for. */
const ALREADY_HANDLED_OPTION_TEXT =
  "Ya te habíamos compartido esa información anteriormente. Un asesor se pondrá en contacto contigo en breve para continuar. 🙂";

/** Sent for the same STALE-tap situation as ALREADY_HANDLED_OPTION_TEXT
 *  (an interactive tap with no active run to route it to — see that
 *  constant's doc comment) but when flow_contact_state does NOT
 *  confirm this exact option was ever recorded as selected — e.g. an
 *  option from before flow_contact_state existed, or one the record
 *  write itself failed for. Deliberately still not silent: from the
 *  customer's side a WhatsApp button never shows as "expired", so an
 *  old message always looks tappable — an honest "we have what you
 *  told us, someone will reach out" beats guessing wrong and staying
 *  quiet, or pretending nothing happened. */
const STALE_INTERACTIVE_TEXT =
  "Recibimos tu mensaje. Ya tenemos tus datos — en un momento un asesor se va a comunicar contigo. 🙂";

/**
 * Pure decision for whether /api/flows/cron should send an inactivity
 * nudge right now. No I/O — the cron route does the DB reads/writes
 * and the actual send; this only computes the boolean.
 *
 * Node-type agnostic: used both for a `collect_ai` node awaiting free
 * text and for a `send_buttons` / `send_list` node awaiting a tap —
 * both configure the same `nudge_after_minutes` / `nudge_text` pair
 * (`CollectAiNodeConfig` and `UnmatchedTextHandling` respectively), and
 * the silence math is identical either way.
 *
 * `optedOut` (contacts.ai_nudge_opt_out) short-circuits everything
 * else — checked first, deliberately, so it can never be bypassed by
 * some combination of the other conditions.
 *
 * The "already nudged" check compares TIMESTAMPS rather than treating
 * `lastNudgeSentAt` as a sticky boolean: a nudge only counts as
 * covering the CURRENT silence period if it was sent AFTER the run's
 * last real activity (`lastAdvancedAt`). Once the customer replies —
 * which already bumps `last_advanced_at` unconditionally, including
 * on a non-text reply via handleCollectAiNonTextReply — any earlier
 * nudge is naturally stale and a fresh silence period becomes
 * nudge-eligible again, with no explicit reset write needed anywhere
 * else in the codebase.
 */
export function shouldSendInactivityNudge(args: {
  ageMinutes: number;
  nudgeAfterMinutes: number;
  lastAdvancedAt: string;
  lastNudgeSentAt: string | null;
  optedOut: boolean;
}): boolean {
  const { ageMinutes, nudgeAfterMinutes, lastAdvancedAt, lastNudgeSentAt, optedOut } = args;
  if (optedOut) return false;
  const alreadyNudgedThisPeriod =
    lastNudgeSentAt !== null && new Date(lastNudgeSentAt) > new Date(lastAdvancedAt);
  if (alreadyNudgedThisPeriod) return false;
  return ageMinutes >= nudgeAfterMinutes;
}

/** Reset the node-visit turn counter to 0. Mirrors how `reprompt_count`
 *  already resets to 0 on every successful match elsewhere in this file. */
async function resetAiTurnCount(db: AdminClient, run: FlowRunRow): Promise<void> {
  const { error } = await db
    .from("flow_runs")
    .update({ ai_turn_count: 0 })
    .eq("id", run.id);
  if (!error) run.ai_turn_count = 0;
}

async function incrementAiTurnCount(db: AdminClient, run: FlowRunRow): Promise<void> {
  const next = (run.ai_turn_count ?? 0) + 1;
  const { error } = await db
    .from("flow_runs")
    .update({ ai_turn_count: next })
    .eq("id", run.id);
  if (!error) run.ai_turn_count = next;
}

/**
 * Merge only the non-empty values `extractWithReply` returned this
 * turn into `run.vars` — never overwrites an already-captured field
 * with an absent/empty extraction, since the model not mentioning a
 * field this turn must not erase a previous answer. No-ops (no write)
 * when there's nothing new, same defensive style as `set_tag`'s
 * failure handling below.
 */
async function mergeCollectAiFields(
  db: AdminClient,
  run: FlowRunRow,
  extracted: Record<string, string>,
): Promise<void> {
  if (Object.keys(extracted).length === 0) return;
  const newVars = { ...run.vars, ...extracted };
  const { error } = await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
  if (!error) run.vars = newVars;
  // Persist per-contact, independent of whether the run-row write above
  // succeeded — a future run for this same contact should never have
  // to ask this again. AWAITED, not fire-and-forget: a serverless
  // instance can freeze right after the response is sent, before a
  // dangling (un-awaited) promise gets to run — losing this write
  // silently. That previously meant a customer re-tapping an old
  // menu option sometimes got treated as brand new (the "already
  // selected" check reads this same per-contact state) instead of the
  // honest "ya tenemos tus datos" notice. mergeFlowKnownVars swallows
  // its own errors (never throws), so this can't turn a DB hiccup into
  // a broken turn — it only adds the RPC's own latency, a few ms.
  await mergeFlowKnownVars(db, run.account_id, run.contact_id, extracted);
}

function collectAiCollectedKeys(
  fields: ExtractionField[],
  vars: Record<string, unknown>,
): string[] {
  return fields
    .filter((f) => typeof vars[f.key] === "string" && (vars[f.key] as string).trim())
    .map((f) => f.key);
}

/**
 * Make one `extractWithReply` call for this node: loads the account's
 * AI config, builds the known-vs-missing field view from `run.vars`,
 * and feeds the same recent-conversation context the auto-reply bot
 * uses (`buildConversationContext`) — so the opening call already
 * sees whatever text triggered entry into this node (e.g. a keyword
 * flow whose trigger message already contains everything). Returns
 * `null` on ANY failure — missing/inactive AI config, network error,
 * timeout, invalid key, malformed extraction — so the caller can
 * route to a handoff instead of throwing mid-run (this function NEVER
 * throws, mirroring `dispatchInboundToAiReply`'s own contract).
 */
async function runCollectAiTurn(
  db: AdminClient,
  run: FlowRunRow,
  cfg: CollectAiNodeConfig,
): Promise<ExtractResult | null> {
  let config;
  try {
    config = await loadAiConfig(db, run.account_id);
  } catch (err) {
    console.error(
      "[flows] collect_ai loadAiConfig failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  if (!config) {
    console.error(
      `[flows] collect_ai node fired for account ${run.account_id} with no active AI config — handing off.`,
    );
    return null;
  }

  const knownValues: Record<string, string> = {};
  for (const f of cfg.fields) {
    const v = run.vars[f.key];
    if (typeof v === "string" && v.trim()) knownValues[f.key] = v;
  }

  const messages = run.conversation_id
    ? await buildConversationContext(db, run.conversation_id, undefined, {
        includeImages: config.visionEnabled,
      })
    : [];

  try {
    const result = await extractWithReply({
      config,
      fields: cfg.fields,
      knownValues,
      systemContext: cfg.system_context,
      messages,
      // Empty/omitted when the node offers no documents — the schema
      // then never exposes a `send_document` slot at all (schema.ts).
      documents: cfg.documents?.map((d) => ({ key: d.key, label: d.label })),
    });
    // Fire-and-forget, same as dispatchInboundToAiReply's own call site
    // — logAiUsage never throws, and awaiting it would only add latency
    // to the customer-facing send for zero benefit. Logged under its
    // own 'flow_collect' mode so the Usage tab can break this node's
    // spend out from auto-reply/draft rather than folding it in.
    void logAiUsage(db, {
      accountId: run.account_id,
      conversationId: run.conversation_id,
      mode: "flow_collect",
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });
    return result;
  } catch (err) {
    console.error(
      "[flows] collect_ai extractWithReply failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Route a collect_ai exit that isn't a clean `done` toward its
 * configured `handoff_node_key`, or — when unset — straight to a
 * human via the same conversation-pending mechanics `executeHandoff`
 * uses below. Whatever was already merged into `run.vars` travels
 * with the run either way, so a human (or the next node) sees
 * whatever got captured before the loop bailed.
 *
 * `message` is the model's own courtesy line (only ever set for
 * `model_handoff`) — the other three handoff reasons (provider
 * failure, max_turns exhausted, empty reply) have no model text to
 * fall back on, so without `cfg.handoff_fallback_text` those exits
 * are silent: the customer sees the bot just stop replying. Prefer
 * the model's message when there is one; otherwise fall back to the
 * flow author's configured text, and only stay silent if neither is
 * set (backward-compatible default for nodes saved before this field
 * existed).
 */
async function handOffFromCollectAi(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: CollectAiNodeConfig,
  nodes: Map<string, FlowNodeRow>,
  reason: CollectAiHandoffReason,
  message?: string,
): Promise<{ outcome: "advanced" | "handed_off" | "completed" }> {
  // Outside business hours, the configured after-hours text wins over
  // EVERYTHING else — including the model's own courtesy line — because
  // the model has no clock and must never be the one deciding
  // time-sensitive wording. Only kicks in when the node actually
  // configured `handoff_fallback_text_after_hours`; unset means this
  // whole check is skipped and behavior is identical to before it
  // existed. Scoped to this one function only — every other node type,
  // the welcome menu, and collect_ai's own continue/complete sends
  // never call isWithinBusinessHours at all.
  const afterHoursText = cfg.handoff_fallback_text_after_hours?.trim();
  const useAfterHoursText = Boolean(afterHoursText) && !isWithinBusinessHours();
  const outgoingText = useAfterHoursText
    ? afterHoursText!
    : message?.trim() || cfg.handoff_fallback_text?.trim();
  // True only when `outgoingText` actually ended up being the model's
  // own courtesy line (`message`, model_handoff only) — the static
  // `handoff_fallback_text` / after-hours fallback is author-written,
  // not AI-generated, same distinction the inbox badge relies on.
  const usedModelMessage = !useAfterHoursText && Boolean(message?.trim());

  // Duplicate guard — only for the TERMINAL handoff below (no
  // handoff_node_key): that's the branch that can repeat verbatim for
  // a customer already queued for a human, see wasHandedOffRecently's
  // doc comment. When handoff_node_key IS set this call advances to a
  // different node instead, which is never a "same outcome again" —
  // that branch always sends its message.
  const isDuplicate =
    !cfg.handoff_node_key && run.conversation_id
      ? await wasHandedOffRecently(db, run.conversation_id)
      : false;

  if (outgoingText && !isDuplicate) {
    try {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: outgoingText,
        aiGenerated: usedModelMessage,
      });
    } catch (err) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "collect_ai_handoff_message_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await logEvent(db, run.id, "handoff", node.node_key, {
    node_type: "collect_ai",
    reason,
    collected_keys: collectAiCollectedKeys(cfg.fields, run.vars),
    ...(isDuplicate ? { duplicate: true } : {}),
  });

  if (cfg.handoff_node_key) {
    return advanceFromNodeKey(db, run, cfg.handoff_node_key, nodes);
  }

  if (run.conversation_id) {
    // Always runs, duplicate or not — it's what keeps the conversation
    // correctly `pending`/`ai_autoreply_disabled: true`; see
    // executeHandoff's identical note on why this write can't be
    // skipped just because the customer-facing message was.
    await markConversationPendingHandoff(
      db,
      run.conversation_id,
      `🤖 El asistente derivó la conversación a un asesor (collect_ai: ${reason}).`,
    );
  }
  await endRun(
    db,
    run.id,
    "handed_off",
    isDuplicate ? `collect_ai_${reason}_duplicate` : `collect_ai_${reason}`,
  );
  return { outcome: "handed_off" };
}

/**
 * Send `text` on a collect_ai node and mark the run suspended there.
 * Idempotent when it's already the current node (the "still missing
 * fields, ask again" case on a reply turn) — `advanceCurrentNodeKey`'s
 * expected-old-key check just matches itself. A Meta-send failure
 * here is an infra failure, not an AI one — mirrors collect_input's
 * own prompt-send handling: hard-fail the run rather than leave it in
 * an undefined state.
 */
async function sendCollectAiTextAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  text: string,
  /** False for `intro_text` (author-written, static); true for a
   *  model-drafted follow-up question (`decideCollectAiOutcome`'s
   *  `continue` case) — see each call site. */
  aiGenerated: boolean,
): Promise<{ outcome: "advanced" | "completed" }> {
  try {
    const { whatsapp_message_id } = await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text,
      aiGenerated,
    });
    await logEvent(db, run.id, "message_sent", node.node_key, {
      node_type: "collect_ai",
      whatsapp_message_id,
    });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "collect_ai_send_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    await endRun(db, run.id, "failed", "collect_ai_send_failed");
    return { outcome: "completed" };
  }
  const advanced = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key);
  if (!advanced) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "lost_race_during_advance",
    });
  }
  return { outcome: "advanced" };
}

/**
 * Send the document the customer asked for this turn (Opción B), if
 * any. A pure side effect alongside whatever continue/complete/handoff
 * `decideCollectAiOutcome` also produces — requesting a catalog mid-
 * collection doesn't interrupt the field-gathering loop, so this is
 * dispatched independently of (and before) that decision. Best-effort:
 * a failed send is logged but never blocks the turn's normal reply —
 * the customer still gets `reply_text` either way.
 */
async function sendCollectAiDocumentIfRequested(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: CollectAiNodeConfig,
  result: ExtractResult | null,
): Promise<void> {
  if (!result?.sendDocument) return;
  const doc = cfg.documents?.find((d) => d.key === result.sendDocument);
  // Absent despite passing parseExtraction's own key check would mean
  // cfg.documents changed between building the schema and this call —
  // stale, not a bug to crash over. Silently skip; reply_text still sends.
  if (!doc) return;

  try {
    await engineSendMedia({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      kind: doc.media_type,
      link: doc.media_url,
      caption: doc.caption,
      filename: doc.filename,
    });
    await logEvent(db, run.id, "message_sent", node.node_key, {
      node_type: "collect_ai",
      document_key: doc.key,
    });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "collect_ai_document_send_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Shared conclusion of one collect_ai turn — used both by the node's
 * entry call (no intro_text configured) and by every reply while
 * suspended on it. Bumps `ai_turn_count` + merges extracted fields
 * (skipped when `result` is null — nothing to merge on a failed
 * call), sends a requested document if any, then dispatches on
 * `decideCollectAiOutcome`.
 */
async function handleCollectAiOutcome(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: CollectAiNodeConfig,
  nodes: Map<string, FlowNodeRow>,
  result: ExtractResult | null,
): Promise<{ outcome: "advanced" | "handed_off" | "completed" }> {
  if (result) {
    await incrementAiTurnCount(db, run);
    await mergeCollectAiFields(db, run, result.fields);
  }

  await sendCollectAiDocumentIfRequested(db, run, node, cfg, result);

  const decision = decideCollectAiOutcome({
    result,
    fields: cfg.fields,
    vars: run.vars,
    turnCount: run.ai_turn_count,
    maxTurns: cfg.max_turns,
  });

  if (decision.kind === "handoff") {
    return handOffFromCollectAi(db, run, node, cfg, nodes, decision.reason, decision.message);
  }

  if (decision.kind === "complete") {
    if (decision.message) {
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: decision.message,
          // decision.message on "complete" is always result.replyText
          // (decideCollectAiOutcome) — the model's own closing line.
          aiGenerated: true,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_ai",
          whatsapp_message_id,
          closing: true,
        });
      } catch (err) {
        // Best-effort — the run still completed successfully even if
        // this closing line didn't land.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_ai_closing_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: "collect_ai",
      collected_keys: collectAiCollectedKeys(cfg.fields, run.vars),
    });
    return advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
  }

  // decision.kind === "continue" — decision.message is always
  // result.replyText (decideCollectAiOutcome), model-drafted.
  return sendCollectAiTextAndSuspend(db, run, node, decision.message, true);
}

/**
 * Enter a collect_ai node for the first time (advancing into it from
 * a prior node, or as a flow's entry node). Resets `ai_turn_count` to
 * 0 for this fresh visit. `intro_text`, when configured, is sent
 * verbatim (zero token cost — matches collect_input's deterministic
 * prompt_text); otherwise one extractWithReply call is made with no
 * known values yet so the model drafts the opening question itself
 * from the surrounding conversation.
 */
export async function enterCollectAiNode(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "handed_off" | "completed" }> {
  const cfg = node.config as unknown as CollectAiNodeConfig;
  await resetAiTurnCount(db, run);

  if (cfg.intro_text && cfg.intro_text.trim()) {
    // Author-written, static — not the model.
    return sendCollectAiTextAndSuspend(
      db,
      run,
      node,
      interpolateVars(cfg.intro_text, run.vars),
      false,
    );
  }

  const result = await runCollectAiTurn(db, run, cfg);
  return handleCollectAiOutcome(db, run, node, cfg, nodes, result);
}

/**
 * Process one customer text reply while suspended on a collect_ai
 * node. Exported (alongside `enterCollectAiNode`) as the two seams
 * `engine.test.ts` drives directly with `extractWithReply` mocked —
 * together they cover the full collect_ai lifecycle without needing
 * to fixture the rest of the dispatch pipeline (flows/flow_nodes
 * lookups, idempotency, the bot-eligibility gate, etc.).
 */
export async function handleCollectAiReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "handed_off" | "completed" }> {
  const cfg = node.config as unknown as CollectAiNodeConfig;
  const result = await runCollectAiTurn(db, run, cfg);
  return handleCollectAiOutcome(db, run, node, cfg, nodes, result);
}

/**
 * Handle a non-text reply (image/audio/sticker/video with no caption)
 * while suspended on a collect_ai node. Exported alongside
 * `handleCollectAiReply` as its own testable seam — kept separate
 * rather than folded into `handleCollectAiReply` so this guard-and-skip
 * path doesn't ripple into that function's existing signature/tests.
 * Never calls extractWithReply: no provider call, no ai_turn_count
 * spent — just the node's configured (or default) fixed reply, reusing
 * the same send-and-stay-suspended helper as intro_text/continue.
 */
export async function handleCollectAiNonTextReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced" | "completed" }> {
  const cfg = node.config as unknown as CollectAiNodeConfig;
  const text = cfg.non_text_reply_text?.trim() || DEFAULT_NON_TEXT_REPLY_TEXT;
  // Fixed reply (author-configured or the hardcoded default) — not the model.
  return sendCollectAiTextAndSuspend(db, run, node, text, false);
}

/**
 * Handle a blank-text reply while suspended on a collect_ai node —
 * the same situation `handleCollectAiNonTextReply` handles, except
 * this is the entry point when the reply carries `audio` (a voice
 * note specifically): attempts a transcription first, before falling
 * back to the fixed non-text reply. Exported alongside
 * `handleCollectAiNonTextReply` as its own testable seam, same reason:
 * keeps `handleReplyForActiveRun` from having to fixture the gate/
 * transcription logic just to exercise its own dispatch.
 *
 * Same gate as `dispatchInboundToAiReply`'s own audio handling
 * (lib/ai/auto-reply.ts): `transcribeAudioEnabled` and
 * `embeddingsApiKey` both required, treated as "off" otherwise — never
 * an error. `transcribeInboundAudio` never throws and returns `null`
 * for every failure mode (download error, transcription error, empty
 * transcript), all of which fall through to the exact same
 * `handleCollectAiNonTextReply` call as when there's no audio at all.
 *
 * On a usable transcript, does NOT pass it to `handleCollectAiReply` —
 * that function never takes reply text as a parameter; it always
 * re-reads the conversation via `buildConversationContext`, which
 * already surfaces a transcribed audio message as if it were text
 * (see context.ts). Persisting the transcript (inside
 * `transcribeInboundAudio`) is the entire job here.
 *
 * `isImageMessage` is the same idea, simpler: unlike audio, there's no
 * secondary key and no transcription-equivalent step to attempt — the
 * webhook already persisted the image's Storage copy synchronously
 * (piece b) before this ever runs, so the gate is just `visionEnabled`.
 * On success, `handleCollectAiReply` re-reads `buildConversationContext`
 * (now with `includeImages`, via `runCollectAiTurn`), which already
 * surfaces the persisted image as vision content — nothing else to do
 * here. Mutually exclusive with the `audio` branch — a single inbound
 * is never both.
 */
export async function handleCollectAiBlankReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
  audio?: InboundAudioRef,
  isImageMessage?: boolean,
): Promise<{ outcome: "advanced" | "handed_off" | "completed" }> {
  if (audio) {
    const config = await loadAiConfig(db, run.account_id);
    if (config?.transcribeAudioEnabled && config.embeddingsApiKey) {
      const transcript = await transcribeInboundAudio(db, {
        accountId: run.account_id,
        audio,
        embeddingsApiKey: config.embeddingsApiKey,
      });
      if (transcript) {
        return handleCollectAiReply(db, run, node, nodes);
      }
    }
  } else if (isImageMessage) {
    const config = await loadAiConfig(db, run.account_id);
    if (config?.visionEnabled) {
      return handleCollectAiReply(db, run, node, nodes);
    }
  }
  return handleCollectAiNonTextReply(db, run, node);
}

/**
 * Cooldown (minutes) before a new handoff outcome for the same
 * conversation is treated as genuine again, instead of a duplicate of
 * one the customer already saw. Shared by all three handoff exits —
 * `executeHandoff`, `handOffFromCollectAi`, and the generic
 * `fallback_policy` "handoff" action — via `wasHandedOffRecently`.
 *
 * Why this exists: `isConversationBotEligible` deliberately lets a
 * flow keep reacting to a PENDING, unclaimed conversation (see its own
 * doc comment) so a customer nobody has picked up yet isn't left
 * stranded. But a `returning_message` trigger starts a brand-new flow
 * run on every single inbound message, and once a topics/menu node's
 * options are all exhausted (`all_selected_node_key`) that new run
 * often lands right back on a handoff node — so a customer who is
 * ALREADY queued and just sends "hola" again a few seconds later used
 * to get the exact same "un asesor va a continuar tu consulta" message
 * again, and the agent-facing pending note got rewritten again, every
 * single time. 30 minutes is long enough to absorb a burst of
 * check-ins while queued, short enough that a customer coming back
 * after a real gap still gets a fresh, visible acknowledgment.
 */
const HANDOFF_DUPLICATE_COOLDOWN_MINUTES = 30;

/**
 * True when this conversation already logged a `handoff` flow_run_event
 * within `HANDOFF_DUPLICATE_COOLDOWN_MINUTES`, across ANY flow_run —
 * a returning customer gets a brand-new run each time (see
 * `HANDOFF_DUPLICATE_COOLDOWN_MINUTES`'s doc comment), so this can't
 * just check the CURRENT run's own events. Reuses `flow_run_events`
 * (already written by every handoff exit) instead of adding a new
 * column — the existing audit trail already answers "when did this
 * conversation last actually hand off", and unlike `conversations.updated_at`
 * it can't be bumped by unrelated activity (a plain inbound message
 * touches that column too, which would make it useless as a cooldown
 * anchor here).
 *
 * `false` on a DB read failure — fails toward the customer still
 * getting a real, visible response rather than silently swallowing a
 * genuine handoff, same convention as this file's other guard checks
 * (e.g. `isConversationBotEligible`, `loadActiveRunForContact`).
 */
async function wasHandedOffRecently(
  db: AdminClient,
  conversationId: string,
): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - HANDOFF_DUPLICATE_COOLDOWN_MINUTES * 60 * 1000,
  ).toISOString();
  const { data, error } = await db
    .from("flow_run_events")
    .select("id, flow_runs!inner(conversation_id)")
    .eq("event_type", "handoff")
    .eq("flow_runs.conversation_id", conversationId)
    .gte("created_at", cutoff)
    .limit(1);
  if (error) return false;
  return Boolean(data && data.length > 0);
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as {
    assign_to?: string;
    note?: string;
    customer_message?: string;
    customer_message_after_hours?: string;
  };
  // Duplicate guard: a customer already queued for a human who sends
  // another message within the cooldown must NOT get the same "un
  // asesor va a continuar tu consulta" message again — see
  // wasHandedOffRecently's doc comment. Only the CUSTOMER-VISIBLE send
  // is skipped; markConversationPendingHandoff below still always
  // runs — it's what keeps the conversation correctly `pending` with
  // `ai_autoreply_disabled: true` (insertAndAdvanceRun unconditionally
  // resets both to "open"/false at the top of every new run, duplicate
  // or not, so skipping this write would wrongly leave a duplicate
  // run's conversation looking "open" and re-eligible for AI auto-reply
  // even though a human still hasn't claimed it).
  const isDuplicate = run.conversation_id
    ? await wasHandedOffRecently(db, run.conversation_id)
    : false;
  // After-hours wins over everything else, same precedence rule as
  // collect_ai's own handoff_fallback_text_after_hours (see
  // handOffFromCollectAi) — only a human/config, never a static
  // author-written string meant for business hours, should decide
  // time-sensitive wording.
  const outOfHours = !isWithinBusinessHours();
  const outgoingMessage = outOfHours
    ? cfg.customer_message_after_hours?.trim() || DEFAULT_HANDOFF_CUSTOMER_MESSAGE_AFTER_HOURS
    : cfg.customer_message?.trim() || DEFAULT_HANDOFF_CUSTOMER_MESSAGE;
  // Sent BEFORE the DB-side handoff writes — best-effort, mirrors every
  // other closing-message send in this file (a failure here is logged
  // but must never block the handoff itself from completing).
  if (!isDuplicate && run.conversation_id && run.contact_id) {
    try {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id,
        contactId: run.contact_id,
        text: outgoingMessage,
      });
    } catch (err) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "handoff_customer_message_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (run.conversation_id) {
    // Interpolated so a note like "Quiere agendar visita para
    // {{vars.visita_dia}} a las {{vars.visita_hora}}" actually shows the
    // customer's answers in the agent-facing summary, instead of the
    // literal template — the only place besides customer-facing prompts
    // this file uses interpolateVars.
    const note = cfg.note ? interpolateVars(cfg.note, run.vars) : null;
    await markConversationPendingHandoff(
      db,
      run.conversation_id,
      note
        ? `🤖 El bot derivó la conversación a un asesor: ${note}`
        : "🤖 El bot derivó la conversación a un asesor.",
      cfg.assign_to,
    );
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
    ...(isDuplicate ? { duplicate: true } : {}),
  });
  await endRun(db, run.id, "handed_off", isDuplicate ? "handoff_node_duplicate" : "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Shared conversation-side effect of every flow handoff (collect_ai's
 * own handoff, a `handoff` node, or fallback_policy exhaustion): mark
 * the thread `pending` AND disable the general assistant's auto-reply
 * on it in the SAME write. The two must always move together — a
 * handoff the customer was just told about ("un asesor va a continuar
 * contigo") must never leave one of the two systems (Flows vs the AI
 * auto-reply) still willing to answer while the other has already
 * stood down.
 *
 * Bug this fixes: a flow-side handoff used to only set `status`, never
 * `ai_autoreply_disabled` — so `dispatchInboundToAiReply` (which only
 * ever checks `ai_autoreply_disabled`/`assigned_agent_id`, never
 * `status`) kept answering new free-text messages on a thread the flow
 * had already told the customer a human would take over.
 */
async function markConversationPendingHandoff(
  db: AdminClient,
  conversationId: string,
  summary: string,
  assignTo?: string,
): Promise<void> {
  const update: Record<string, unknown> = {
    status: "pending",
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
    updated_at: new Date().toISOString(),
  };
  if (assignTo) update.assigned_agent_id = assignTo;
  await db.from("conversations").update(update).eq("id", conversationId);
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      const cfg = node.config as unknown as CollectInputNodeConfig;
      // Already known from a PRIOR run for this same contact (seeded
      // into run.vars at run creation — see insertAndAdvanceRun /
      // flow_contact_state, migration 061)? Skip straight past this
      // question instead of asking it again — this is the manual/
      // collect_input equivalent of collect_ai's own "already
      // collected, don't ask again" behavior.
      const known = run.vars[cfg.var_key];
      if (typeof known === "string" && known.trim()) {
        await logEvent(db, run.id, "node_entered", node.node_key, {
          skipped_already_known: true,
          captured_key: cfg.var_key,
        });
        currentKey = cfg.next_node_key;
        continue;
      }
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "collect_ai") {
      return enterCollectAiNode(db, run, node, nodes);
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      const result = await sendButtonsAndSuspend(db, run, node);
      if (result.outcome === "redirect") {
        // Every button here has already been picked by this contact —
        // nothing was sent. Continue the SAME advance loop from the
        // configured all_selected_node_key instead.
        currentKey = result.node_key;
        continue;
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      const result = await sendListAndSuspend(db, run, node);
      if (result.outcome === "redirect") {
        currentKey = result.node_key;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → before even looking for a matching entry
    // trigger, check whether a human has actually CLAIMED this
    // conversation. A flow (any trigger_type — keyword,
    // first_inbound_message, returning_message) must never start over
    // a conversation an agent owns; see isConversationBotEligible for
    // why 'pending' alone no longer blocks this.
    const conversationGate = await loadConversationGateInfo(
      db,
      input.conversationId,
    );
    if (!isConversationBotEligible(conversationGate)) {
      return { consumed: false, outcome: "no_match" };
    }

    // An interactive tap with no active run left to match it against —
    // the run it belonged to already completed or handed off. findEntryFlow
    // below never matches interactive replies (only text can start a flow),
    // so left unchecked this would silently fall through to the general
    // assistant, which has no memory of ever having sent this option and
    // would re-process it as a brand new request. Most common real-world
    // cause: the customer scrolls up in WhatsApp and re-taps an old button
    // whose option (per flow_contact_state, migration 061) was already
    // fully resolved in some earlier run — give them an honest answer and
    // route to a human instead of restarting or repeating the flow.
    if (input.message.kind === "interactive_reply") {
      const contactState = await loadFlowContactState(
        db,
        input.accountId,
        input.contactId,
      );
      const replyId = input.message.reply_id;
      const alreadyHandled = Object.values(contactState.selected_options).some(
        (ids) => ids.includes(replyId),
      );
      // Either way there is no live run this tap can advance — never
      // fall through to `no_match` here (that used to mean total
      // silence: findEntryFlow never matches interactive replies, and
      // the general assistant has no context for a bare button-tap
      // payload). alreadyHandled just picks the more specific, honest
      // wording when flow_contact_state can actually confirm it.
      try {
        await engineSendText({
          accountId: input.accountId,
          userId: input.userId,
          conversationId: input.conversationId,
          contactId: input.contactId,
          text: alreadyHandled ? ALREADY_HANDLED_OPTION_TEXT : STALE_INTERACTIVE_TEXT,
          aiGenerated: false,
        });
      } catch (err) {
        console.error(
          "[flows] stale-interactive notice send failed:",
          err instanceof Error ? err.message : err,
        );
      }
      await markConversationPendingHandoff(
        db,
        input.conversationId,
        alreadyHandled
          ? "El cliente reabrió una opción del menú que ya había completado antes."
          : "El cliente tocó un botón/lista de un mensaje anterior sin una conversación activa.",
      );
      return {
        consumed: true,
        outcome: alreadyHandled ? "already_selected_notice" : "stale_interactive_notice",
      };
    }

    // No active run, conversation not human-owned → look for a flow
    // whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.conversationId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

// Exported alongside enterCollectAiNode/handleCollectAiReply as its own
// testable seam — engine.test.ts drives it directly with a
// pre-constructed run/node/message, without needing to fixture
// dispatchInboundToFlows's own active-run lookup + idempotency check.
export async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  //
  // This is also the atomic duplicate-inbound claim — see
  // claimReplyReceived's own doc comment. Must run BEFORE anything else
  // in this function (matching, capturing, advancing, sending): a
  // losing concurrent delivery needs to stop here, before it can ever
  // reach a customer-facing send.
  const claimed = await claimReplyReceived(db, run.id, run.current_node_key, message);
  if (!claimed) {
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "duplicate_inbound_ignored",
    };
  }

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // collect_ai owns its own turn-by-turn control flow (extractWithReply,
  // then continue/complete/handoff via decideCollectAiOutcome) — it has
  // no "matched vs unmatched" notion and no fallback_policy reprompt
  // cycle, so every text reply on this node type is handled here and
  // returns early, bypassing the matched/fallback machinery below
  // entirely. A stray interactive_reply on a collect_ai node (should
  // not happen — this node never sends buttons/lists) falls through to
  // the generic fallback path unchanged, same as any other unrecognized
  // node/message combination.
  //
  // The webhook collapses every inbound kind into this same text-shaped
  // message, using an empty string when there's no caption — so a blank
  // `message.text` here means the customer sent media (image, audio,
  // sticker, video), not that they typed nothing. That case skips
  // extractWithReply entirely (handleCollectAiBlankReply →
  // handleCollectAiNonTextReply): no provider call, no ai_turn_count
  // spent — UNLESS `message.audio` is set (a voice note specifically)
  // and the account opted into transcription, or `message.isImageMessage`
  // is set and the account opted into vision — both of which
  // handleCollectAiBlankReply tries first before falling back.
  if (message.kind === "text" && currentNode.node_type === "collect_ai") {
    if (!message.text.trim()) {
      const outcome = await handleCollectAiBlankReply(
        db,
        run,
        currentNode,
        nodes,
        message.audio,
        message.isImageMessage,
      );
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
    const outcome = await handleCollectAiReply(db, run, currentNode, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }

  // Three ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //   3. Free text on a send_buttons/send_list node that hits an
  //      escalation keyword (e.g. "quiero hablar con un asesor") —
  //      jumps straight to handoff_node_key, bypassing the
  //      reprompt/max_reprompts cycle entirely for this reply.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  // Set only for a collect_input reply that failed `validation` — see
  // isValidCollectInputValue's doc comment. Picks a more specific
  // reprompt message (collectInputValidationErrorText) than the
  // generic "resend prompt_text" used for a genuinely empty reply.
  let collectInputValidationFailed = false;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
    if (matched) {
      // Remembered per contact (flow_contact_state) so this exact
      // option is filtered out next time this node is shown — see
      // sendButtonsAndSuspend/sendListAndSuspend. AWAITED — see
      // mergeCollectAiFields' identical note on why fire-and-forget
      // here risked the write never landing (a serverless instance can
      // freeze right after the response, before a dangling promise
      // runs) and the customer's own dispatchInboundToFlows "already
      // selected" check (reads this same state) silently missing it on
      // a re-tap. recordFlowOptionSelected swallows its own errors.
      await recordFlowOptionSelected(
        db,
        run.account_id,
        run.contact_id,
        currentNode.node_key,
        message.reply_id,
      );
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      if (!isValidCollectInputValue(cfg.validation, captured, cfg.regex)) {
        // Leave `matched` unset — falls through to the same
        // fallback_policy reprompt/handoff machinery as an empty
        // reply below, just with collectInputValidationFailed flagging
        // which message to use for the reprompt.
        collectInputValidationFailed = true;
      } else {
        // Persist captured value + reset reprompt count atomically.
        const newVars = { ...run.vars, [cfg.var_key]: captured };
        const { error: capErr } = await db
          .from("flow_runs")
          .update({
            vars: newVars,
            reprompt_count: 0,
          })
          .eq("id", run.id);
        if (!capErr) {
          // Mirror the UPDATE in-memory so downstream interpolation in
          // the advance loop sees the captured var without us having to
          // re-SELECT the whole row.
          run.vars = newVars;
          run.reprompt_count = 0;
          await logEvent(db, run.id, "node_entered", currentNode.node_key, {
            captured_key: cfg.var_key,
            captured_length: captured.length,
          });
          // Same reasoning as mergeCollectAiFields' own persistence — a
          // future run for this contact shouldn't have to ask again.
          // Awaited for the same reliability reason (see that function's
          // doc comment).
          await mergeFlowKnownVars(db, run.account_id, run.contact_id, {
            [cfg.var_key]: captured,
          });
          matched = cfg.next_node_key;
        }
      }
    }
  } else if (
    message.kind === "text" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    const cfg = currentNode.config as unknown as
      | SendButtonsNodeConfig
      | SendListNodeConfig;
    const textRoute = matchTextRoute(cfg.text_routes, message.text);
    if (
      cfg.handoff_node_key &&
      cfg.unmatched_text_keywords &&
      cfg.unmatched_text_keywords.length > 0 &&
      matchesKeywordTrigger(message.text, {
        keywords: cfg.unmatched_text_keywords,
        match_type: "contains",
      })
    ) {
      matched = cfg.handoff_node_key;
    } else if (textRoute) {
      // e.g. "precio"/"cotizar" jumping straight to collect_inox_quote
      // instead of a generic reprompt or human handoff. See TextRoute's
      // doc comment (types.ts) for precedence vs. the escalation branch
      // above and release_unmatched_text_to_assistant below.
      matched = textRoute.node_key;
      if (textRoute.also_marks_selected) {
        // e.g. typing "catálogo" instead of tapping the row — treated
        // exactly like a real tap for exclusion purposes, see
        // TextRoute.also_marks_selected's doc comment. Awaited — same
        // reliability reason as the interactive-tap branch above.
        await recordFlowOptionSelected(
          db,
          run.account_id,
          run.contact_id,
          currentNode.node_key,
          textRoute.also_marks_selected,
        );
      }
    } else if (cfg.release_unmatched_text_to_assistant) {
      // Free text that isn't a button tap and isn't an escalation
      // keyword (checked above — always wins first) — end the run and
      // let the webhook fall through to the general auto-reply
      // assistant with this same inbound message, instead of applying
      // fallback_policy. Ends the run (rather than leaving it active,
      // the way fallback_policy's own "ignore" action does) so a LATER
      // message can match an entry trigger again — dispatchInboundToFlows
      // never even looks at entry triggers while an active run exists.
      await endRun(db, run.id, "completed", "released_to_assistant");
      return {
        consumed: false,
        flow_run_id: run.id,
        outcome: "released_to_assistant",
      };
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    if (
      currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list"
    ) {
      // Optional clarifying line ("¿Podés elegir una opción de la
      // lista de arriba?") sent as its own message right before the
      // resend, so the customer understands why they're seeing the
      // same prompt again. Best-effort — a failure here must not
      // block the resend itself.
      const cfg = currentNode.config as unknown as
        | SendButtonsNodeConfig
        | SendListNodeConfig;
      const hintText = !isWithinBusinessHours()
        ? cfg.reprompt_hint_text_after_hours?.trim() || cfg.reprompt_hint_text
        : cfg.reprompt_hint_text;
      if (hintText) {
        try {
          await engineSendText({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text: hintText,
          });
        } catch (err) {
          await logEvent(db, run.id, "error", currentNode.node_key, {
            reason: "reprompt_hint_send_failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (currentNode.node_type === "send_buttons") {
      const result = await sendButtonsAndSuspend(db, run, currentNode);
      if (result.outcome === "redirect") {
        // This contact has since picked every button here (e.g. via a
        // different, now-ended run) — hand off to the normal advance
        // loop instead of resending an all-hidden prompt.
        const outcome = await advanceFromNodeKey(db, run, result.node_key, nodes);
        return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
      }
    } else if (currentNode.node_type === "send_list") {
      const result = await sendListAndSuspend(db, run, currentNode);
      if (result.outcome === "redirect") {
        const outcome = await advanceFromNodeKey(db, run, result.node_key, nodes);
        return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
      }
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept: either empty
      // after trim / var_key missing (rare), or it failed `validation`
      // (collectInputValidationFailed) — e.g. "987" isn't a valid
      // 9-digit phone number. The latter gets a specific, more formal
      // re-ask instead of just repeating the original question
      // verbatim; either way the SAME reprompt/max_reprompts/handoff
      // cycle as every other node type applies (see fallback_policy).
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      const reText = collectInputValidationFailed
        ? collectInputValidationErrorText(cfg)
        : cfg.prompt_text;
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(reText, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    // Duplicate guard — same reasoning as executeHandoff's own, see
    // wasHandedOffRecently's doc comment: a customer already queued
    // for a human who keeps typing off-script must not get the same
    // closing message every single time their fallback_policy exhausts
    // again. markConversationPendingHandoff below still always runs
    // regardless — see executeHandoff's note on why that write can't
    // be skipped just because the customer-facing message was.
    const isDuplicate = run.conversation_id
      ? await wasHandedOffRecently(db, run.conversation_id)
      : false;
    // Same reasoning as executeHandoff's own send: this exit used to be
    // completely silent to the customer — best-effort, must not block
    // the handoff itself.
    if (!isDuplicate && run.conversation_id && run.contact_id) {
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id,
          contactId: run.contact_id,
          text: isWithinBusinessHours()
            ? DEFAULT_HANDOFF_CUSTOMER_MESSAGE
            : DEFAULT_HANDOFF_CUSTOMER_MESSAGE_AFTER_HOURS,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", run.current_node_key, {
          reason: "fallback_handoff_customer_message_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (run.conversation_id) {
      await markConversationPendingHandoff(
        db,
        run.conversation_id,
        "🤖 El bot derivó la conversación a un asesor tras varios intentos sin una respuesta reconocida.",
      );
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
      ...(isDuplicate ? { duplicate: true } : {}),
    });
    await endRun(
      db,
      run.id,
      "handed_off",
      isDuplicate ? "fallback_exhausted_duplicate" : "fallback_exhausted",
    );
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

/**
 * Shared insert+advance logic for starting a brand-new flow_run,
 * entering directly at `nodeKey`. Used by both `startNewRun` (normal
 * entry-trigger match — `nodeKey` is always `flow.entry_node_id`) and
 * the exported `startFlowRunAtNode` below (started from OUTSIDE normal
 * entry-trigger matching, at whatever node the caller already knows is
 * the right one).
 */
async function insertAndAdvanceRun(
  db: AdminClient,
  flow: FlowRow,
  nodeKey: string,
  contactId: string,
  conversationId: string,
  nodes: Map<string, FlowNodeRow>,
  startedVia: Record<string, unknown>,
): Promise<DispatchInboundResult> {
  // Has THIS flow ever run for this contact before? Checked BEFORE the
  // insert below (a fresh row for this exact run would otherwise always
  // count as "one prior run"). Drives `vars.is_reentry`, which
  // send_list/send_buttons nodes can use (via `reentry_text`) to skip
  // re-showing a "Bienvenido..." framing that only makes sense the
  // first time — see sendListAndSuspend/sendButtonsAndSuspend. Scoped
  // to (contact_id, flow_id): switching between two DIFFERENT flows
  // (e.g. the AI and manual variants) is its own "first time" each.
  const { count: priorRunCount } = await db
    .from("flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .eq("flow_id", flow.id);
  const isReentry = (priorRunCount ?? 0) > 0;

  // Seed this run's vars with whatever this contact has already told
  // ANY prior run (see flow_contact_state, migration 061) — so
  // collect_ai's own "already known, don't ask again" logic and
  // collect_input's skip-if-known check (advanceFromNodeKey) both see
  // it from the very first turn, instead of asking again from scratch.
  const contactState = await loadFlowContactState(db, flow.account_id, contactId);

  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook — or in startFlowRunAtNode's
  // case, an already-active run from some other path — handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: contactId,
      conversation_id: conversationId,
      status: "active",
      current_node_key: nodeKey,
      vars: { ...contactState.known_vars, is_reentry: isReentry },
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] insertAndAdvanceRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", nodeKey, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    ...startedVia,
  });

  // A new run starting means the bot is actively engaging this contact
  // again — reset the conversation off of any stale 'pending'/disabled
  // state left over from a PRIOR run's handoff that nobody ended up
  // claiming. Unconditional (not just when it was actually pending) —
  // a harmless no-op write when it was already open. Mirrors, in
  // reverse, markConversationPendingHandoff's own write.
  await db
    .from("conversations")
    .update({ status: "open", ai_autoreply_disabled: false, updated_at: new Date().toISOString() })
    .eq("id", conversationId);
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, nodeKey, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  return insertAndAdvanceRun(
    db,
    flow,
    flow.entry_node_id!,
    input.contactId,
    input.conversationId,
    nodes,
    { meta_message_id: input.message.meta_message_id },
  );
}

/**
 * Start a flow_run OUTSIDE the normal entry-trigger flow, entering
 * directly at `nodeKey` — for a caller that already knows exactly
 * which node is the right starting point, because Flow entry triggers
 * (text/keyword-only — see `findEntryFlow`'s `if (message.kind !==
 * "text") return null`) could never have matched what actually
 * happened. Today's only caller: the webhook's template-button-reply
 * handler — a WhatsApp template quick-reply tap arrives as Meta
 * `type: 'button'`, structurally different from (and unhandled by) the
 * `interactive` shape send_buttons/send_list use, and there's no
 * active flow_run to advance either (the template was sent well after
 * any prior conversation ended).
 *
 * Self-contained (own `supabaseAdmin()`, own flow/nodes load) so a
 * caller outside this file's own dispatch loop — like the webhook —
 * doesn't need to pre-load anything. Scoped to `accountId` defensively:
 * a caller passing a `flowId` from the wrong account gets `no_match`,
 * never a cross-tenant write.
 */
export async function startFlowRunAtNode(args: {
  accountId: string;
  flowId: string;
  nodeKey: string;
  contactId: string;
  conversationId: string;
  /** Logged on the 'started' flow_run_events row for audit context —
   *  e.g. `{ reason: 'template_button_reply', button_text: '...' }`. */
  startedVia: Record<string, unknown>;
}): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  const flow = await loadFlow(db, args.flowId);
  if (!flow || flow.account_id !== args.accountId) {
    return { consumed: false, outcome: "no_match" };
  }
  const nodes = await loadAllNodes(db, flow.id);
  if (!nodes.has(args.nodeKey)) {
    console.error(
      `[flows] startFlowRunAtNode: node "${args.nodeKey}" not found in flow ${flow.id}`,
    );
    return { consumed: false, outcome: "no_match" };
  }
  return insertAndAdvanceRun(
    db,
    flow,
    args.nodeKey,
    args.contactId,
    args.conversationId,
    nodes,
    args.startedVia,
  );
}
