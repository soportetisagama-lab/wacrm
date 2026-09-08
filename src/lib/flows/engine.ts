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
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { loadAiConfig } from "@/lib/ai/config";
import { buildConversationContext } from "@/lib/ai/context";
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

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
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

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Gate on every entry-trigger match (keyword, first_inbound_message,
 * returning_message alike): a flow must never start over a
 * conversation a human is already handling. "Handling" means either
 * `status === 'pending'` (mid-handoff, no agent has necessarily
 * claimed it yet — see executeHandoff in this file) or
 * `assigned_agent_id` is set (an agent has claimed it, independent of
 * status — see migration 038).
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
  conversation: { status: string; assigned_agent_id: string | null } | null,
): boolean {
  if (!conversation) return true;
  return conversation.status !== "pending" && conversation.assigned_agent_id === null;
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
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
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
 * Conversation fields the entry-trigger gate needs. One indexed
 * by-PK lookup — only hit on the "no active run" path, which is
 * already the less-common branch of dispatch.
 */
async function loadConversationGateInfo(
  db: AdminClient,
  conversationId: string,
): Promise<{ status: string; assigned_agent_id: string | null } | null> {
  const { data, error } = await db
    .from("conversations")
    .select("status, assigned_agent_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadConversationGateInfo error:", error.message);
    return null;
  }
  return (data as { status: string; assigned_agent_id: string | null } | null) ?? null;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

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
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
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

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
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
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
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

/** Default for CollectAiNodeConfig.nudge_text when a node sets
 *  nudge_after_minutes but not this. Sent by the /api/flows/cron
 *  sweep, not by the engine itself. */
export const DEFAULT_NUDGE_TEXT =
  "¿Seguís ahí? Quedé esperando tu respuesta para poder continuar con tu consulta.";

/**
 * Pure decision for whether /api/flows/cron should send a collect_ai
 * inactivity nudge right now. No I/O — the cron route does the DB
 * reads/writes and the actual send; this only computes the boolean.
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
export function shouldSendCollectAiNudge(args: {
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
    ? await buildConversationContext(db, run.conversation_id)
    : [];

  try {
    const result = await extractWithReply({
      config,
      fields: cfg.fields,
      knownValues,
      systemContext: cfg.system_context,
      messages,
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
  const outgoingText = message?.trim() || cfg.handoff_fallback_text?.trim();
  if (outgoingText) {
    try {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: outgoingText,
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
  });

  if (cfg.handoff_node_key) {
    return advanceFromNodeKey(db, run, cfg.handoff_node_key, nodes);
  }

  if (run.conversation_id) {
    await db
      .from("conversations")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", run.conversation_id);
  }
  await endRun(db, run.id, "handed_off", `collect_ai_${reason}`);
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
): Promise<{ outcome: "advanced" | "completed" }> {
  try {
    const { whatsapp_message_id } = await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text,
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
 * Shared conclusion of one collect_ai turn — used both by the node's
 * entry call (no intro_text configured) and by every reply while
 * suspended on it. Bumps `ai_turn_count` + merges extracted fields
 * (skipped when `result` is null — nothing to merge on a failed
 * call), then dispatches on `decideCollectAiOutcome`.
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

  // decision.kind === "continue"
  return sendCollectAiTextAndSuspend(db, run, node, decision.message);
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
    return sendCollectAiTextAndSuspend(db, run, node, interpolateVars(cfg.intro_text, run.vars));
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
  return sendCollectAiTextAndSuspend(db, run, node, text);
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
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
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
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
      await sendButtonsAndSuspend(db, run, node);
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
      await sendListAndSuspend(db, run, node);
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
    // trigger, check whether a human already owns this conversation.
    // A flow (any trigger_type — keyword, first_inbound_message,
    // returning_message) must never start over a conversation that's
    // 'pending' or assigned to an agent; see isConversationBotEligible.
    const conversationGate = await loadConversationGateInfo(
      db,
      input.conversationId,
    );
    if (!isConversationBotEligible(conversationGate)) {
      return { consumed: false, outcome: "no_match" };
    }

    // No active run, conversation not human-owned → look for a flow
    // whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
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

async function handleReplyForActiveRun(
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
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

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
  // extractWithReply entirely (handleCollectAiNonTextReply): no
  // provider call, no ai_turn_count spent.
  if (message.kind === "text" && currentNode.node_type === "collect_ai") {
    if (!message.text.trim()) {
      const outcome = await handleCollectAiNonTextReply(db, run, currentNode);
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
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
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
        matched = cfg.next_node_key;
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
      if (cfg.reprompt_hint_text) {
        try {
          await engineSendText({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text: cfg.reprompt_hint_text,
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
      await sendButtonsAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
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
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
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
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
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
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
