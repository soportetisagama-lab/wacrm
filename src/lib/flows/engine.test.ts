import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked BEFORE importing ./engine so its module-level import binds to
// these mocks — engine.ts calls extractWithReply/loadAiConfig/
// buildConversationContext/engineSendText as plain function imports,
// so replacing the modules is enough (no DI needed in engine.ts).
vi.mock("@/lib/ai/generate", () => ({ extractWithReply: vi.fn() }));
vi.mock("@/lib/ai/config", () => ({ loadAiConfig: vi.fn() }));
vi.mock("@/lib/ai/context", () => ({ buildConversationContext: vi.fn() }));
vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  engineSendMedia: vi.fn(),
}));

import {
  matchReplyId,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
  isConversationBotEligible,
  decideCollectAiOutcome,
  collectAiRequiredFieldsPresent,
  enterCollectAiNode,
  handleCollectAiReply,
  handleCollectAiNonTextReply,
  shouldSendCollectAiNudge,
  resolveTemplateButtonAction,
} from "./engine";
import { extractWithReply } from "@/lib/ai/generate";
import { loadAiConfig } from "@/lib/ai/config";
import { buildConversationContext } from "@/lib/ai/context";
import { engineSendText } from "./meta-send";
import type { AiConfig } from "@/lib/ai/types";
import type { CollectAiNodeConfig, FlowNodeRow, FlowRunRow } from "./types";

describe("matchReplyId", () => {
  it("returns null for nodes without options", () => {
    expect(
      matchReplyId({ node_type: "start", config: { next_node_key: "x" } }, "y"),
    ).toBeNull();
    expect(
      matchReplyId({ node_type: "send_message", config: {} }, "y"),
    ).toBeNull();
    expect(matchReplyId({ node_type: "end", config: {} }, "y")).toBeNull();
  });

  it("matches the buttons array on a send_buttons node", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick one",
        buttons: [
          { reply_id: "yes", title: "Yes", next_node_key: "confirmed" },
          { reply_id: "no", title: "No", next_node_key: "declined" },
        ],
      },
    };
    expect(matchReplyId(node, "yes")).toBe("confirmed");
    expect(matchReplyId(node, "no")).toBe("declined");
  });

  it("returns null when no button reply_id matches", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick",
        buttons: [
          { reply_id: "a", title: "A", next_node_key: "to_a" },
          { reply_id: "b", title: "B", next_node_key: "to_b" },
        ],
      },
    };
    expect(matchReplyId(node, "c")).toBeNull();
    expect(matchReplyId(node, "")).toBeNull();
  });

  it("searches across all sections in a send_list node", () => {
    const node = {
      node_type: "send_list",
      config: {
        text: "Pick an order",
        button_label: "View",
        sections: [
          {
            title: "Recent",
            rows: [
              { reply_id: "o1", title: "Order 1", next_node_key: "ord_1" },
            ],
          },
          {
            title: "Older",
            rows: [
              { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
              { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, "o1")).toBe("ord_1");
    expect(matchReplyId(node, "o2")).toBe("ord_2");
    expect(matchReplyId(node, "o3")).toBe("ord_3");
    expect(matchReplyId(node, "o99")).toBeNull();
  });

  it("returns null when send_list has no sections / empty sections", () => {
    expect(
      matchReplyId(
        { node_type: "send_list", config: { text: "x", sections: [] } },
        "x",
      ),
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: "send_list",
          config: { text: "x", sections: [{ rows: [] }] },
        },
        "x",
      ),
    ).toBeNull();
  });
});

describe("matchesKeywordTrigger", () => {
  it("returns false for empty text", () => {
    expect(matchesKeywordTrigger("", { keywords: ["hi"] })).toBe(false);
  });

  it("returns false when keywords array is empty", () => {
    expect(matchesKeywordTrigger("anything", { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ["support"] };
    expect(matchesKeywordTrigger("I need SUPPORT please", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Support is great", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Help me", cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ["help"], match_type: "exact" as const };
    expect(matchesKeywordTrigger("help", cfg)).toBe(true);
    expect(matchesKeywordTrigger("HELP", cfg)).toBe(true);
    expect(matchesKeywordTrigger("help me", cfg)).toBe(false);
  });

  it("case_sensitive=true preserves case", () => {
    const cfg = {
      keywords: ["Support"],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger("I need Support", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need support", cfg)).toBe(false);
  });

  it("matches any one of multiple keywords", () => {
    const cfg = { keywords: ["help", "support", "issue"] };
    expect(matchesKeywordTrigger("I have an issue", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need Help!", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nothing to see here", cfg)).toBe(false);
  });

  it("skips empty strings in the keywords array", () => {
    const cfg = { keywords: ["", "support", ""] };
    expect(matchesKeywordTrigger("support center", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nope", cfg)).toBe(false);
  });
});

describe("resolveTemplateButtonAction", () => {
  it("maps the accented quote-request button to start_quote", () => {
    expect(resolveTemplateButtonAction("Sí, quiero info")).toEqual({
      action: "start_quote",
    });
  });

  it("also matches the unaccented variant", () => {
    expect(resolveTemplateButtonAction("Si, quiero info")).toEqual({
      action: "start_quote",
    });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveTemplateButtonAction("  SÍ, QUIERO INFO  ")).toEqual({
      action: "start_quote",
    });
  });

  it("maps the decline button to close", () => {
    expect(resolveTemplateButtonAction("Ya no me interesa")).toEqual({
      action: "close",
    });
  });

  it("returns null for any other button text", () => {
    expect(resolveTemplateButtonAction("Some other template's button")).toBeNull();
    expect(resolveTemplateButtonAction("")).toBeNull();
  });
});

describe("node classification helpers", () => {
  it("isAutoAdvancing covers start + send_message + send_media + condition + set_tag", () => {
    expect(isAutoAdvancing("start")).toBe(true);
    expect(isAutoAdvancing("send_message")).toBe(true);
    expect(isAutoAdvancing("send_media")).toBe(true);
    expect(isAutoAdvancing("condition")).toBe(true);
    expect(isAutoAdvancing("set_tag")).toBe(true);
    expect(isAutoAdvancing("send_buttons")).toBe(false);
    expect(isAutoAdvancing("send_list")).toBe(false);
    expect(isAutoAdvancing("collect_input")).toBe(false);
    expect(isAutoAdvancing("handoff")).toBe(false);
    expect(isAutoAdvancing("end")).toBe(false);
  });

  it("isSuspending covers the input-requiring nodes", () => {
    expect(isSuspending("send_buttons")).toBe(true);
    expect(isSuspending("send_list")).toBe(true);
    expect(isSuspending("collect_input")).toBe(true);
    expect(isSuspending("collect_ai")).toBe(true);
    expect(isSuspending("start")).toBe(false);
    expect(isSuspending("send_message")).toBe(false);
    expect(isSuspending("condition")).toBe(false);
    expect(isSuspending("set_tag")).toBe(false);
    expect(isSuspending("handoff")).toBe(false);
    expect(isSuspending("end")).toBe(false);
  });

  it("isTerminal covers handoff + end", () => {
    expect(isTerminal("handoff")).toBe(true);
    expect(isTerminal("end")).toBe(true);
    expect(isTerminal("start")).toBe(false);
    expect(isTerminal("send_buttons")).toBe(false);
    expect(isTerminal("condition")).toBe(false);
  });

  it("the three classifications are mutually exclusive for known node types", () => {
    const types = [
      "start",
      "send_message",
      "send_buttons",
      "send_list",
      "send_media",
      "collect_input",
      "collect_ai",
      "condition",
      "set_tag",
      "handoff",
      "end",
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe("evaluateConditionPredicate", () => {
  it("present: true when subject has a value", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "alice@example.com",
        configValue: undefined,
      }),
    ).toBe(true);
  });

  it("present: false when subject is undefined or empty", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("absent: inverse of present", () => {
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: "x",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("equals: exact string comparison; case-sensitive", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "VIP",
        configValue: "VIP",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "vip",
        configValue: "VIP",
      }),
    ).toBe(false);
  });

  it("equals: undefined subject never matches (even against empty)", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: undefined,
        configValue: "",
      }),
    ).toBe(false);
  });

  it("contains: substring match", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@example.com",
        configValue: "@example.com",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@other.com",
        configValue: "@example.com",
      }),
    ).toBe(false);
  });

  it("contains: undefined subject never matches", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: undefined,
        configValue: "anything",
      }),
    ).toBe(false);
  });
});

describe("isConversationBotEligible", () => {
  it("eligible when open and unassigned", () => {
    expect(
      isConversationBotEligible({ status: "open", assigned_agent_id: null }),
    ).toBe(true);
  });

  it("eligible when closed and unassigned", () => {
    expect(
      isConversationBotEligible({ status: "closed", assigned_agent_id: null }),
    ).toBe(true);
  });

  it("not eligible when pending, even if unassigned", () => {
    expect(
      isConversationBotEligible({ status: "pending", assigned_agent_id: null }),
    ).toBe(false);
  });

  it("not eligible when assigned to an agent, even if status is open", () => {
    expect(
      isConversationBotEligible({ status: "open", assigned_agent_id: "agent-1" }),
    ).toBe(false);
  });

  it("not eligible when both pending and assigned", () => {
    expect(
      isConversationBotEligible({
        status: "pending",
        assigned_agent_id: "agent-1",
      }),
    ).toBe(false);
  });

  it("fails open (eligible) when the conversation lookup came back null", () => {
    // Mirrors this file's existing convention for DB read failures on
    // guard checks: a transient error shouldn't silently mute every
    // flow trigger for the account.
    expect(isConversationBotEligible(null)).toBe(true);
  });
});

// ============================================================
// collect_ai — pure decision logic
// ============================================================

const FIELDS: CollectAiNodeConfig["fields"] = [
  { key: "equipos", label: "Equipos", required: true },
  { key: "ciudad", label: "Ciudad", required: true },
  { key: "rubro", label: "Rubro", required: false },
];

describe("collectAiRequiredFieldsPresent", () => {
  it("true when there are no required fields at all", () => {
    expect(
      collectAiRequiredFieldsPresent(
        [{ key: "rubro", label: "Rubro", required: false }],
        {},
      ),
    ).toBe(true);
  });

  it("false when a required field is missing from vars", () => {
    expect(
      collectAiRequiredFieldsPresent(FIELDS, { equipos: "2 cocinas" }),
    ).toBe(false);
  });

  it("false when a required field is present but blank", () => {
    expect(
      collectAiRequiredFieldsPresent(FIELDS, { equipos: "2 cocinas", ciudad: "   " }),
    ).toBe(false);
  });

  it("true once every required field has a non-blank value — optional fields don't matter", () => {
    expect(
      collectAiRequiredFieldsPresent(FIELDS, { equipos: "2 cocinas", ciudad: "Trujillo" }),
    ).toBe(true);
  });
});

function extractResult(overrides: Partial<{
  fields: Record<string, string>;
  replyText: string;
  done: boolean;
  handoff: boolean;
}> = {}) {
  return {
    fields: {},
    replyText: "¿En qué ciudad?",
    done: false,
    handoff: false,
    usage: null,
    ...overrides,
  };
}

describe("decideCollectAiOutcome", () => {
  it("handoff/provider_error when result is null (network/timeout/invalid key/malformed extraction)", () => {
    expect(
      decideCollectAiOutcome({ result: null, fields: FIELDS, vars: {}, turnCount: 1, maxTurns: 6 }),
    ).toEqual({ kind: "handoff", reason: "provider_error" });
  });

  it("handoff/model_handoff when the model sets handoff:true, forwarding its reply_text as a courtesy message", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ handoff: true, replyText: "Te paso con un asesor." }),
        fields: FIELDS,
        vars: {},
        turnCount: 1,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "handoff", reason: "model_handoff", message: "Te paso con un asesor." });
  });

  it("handoff/model_handoff omits message when reply_text is blank", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ handoff: true, replyText: "  " }),
        fields: FIELDS,
        vars: {},
        turnCount: 1,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "handoff", reason: "model_handoff", message: undefined });
  });

  it("complete when done:true AND every required field is actually present in vars", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ done: true, replyText: "¡Gracias! Un asesor te contactará." }),
        fields: FIELDS,
        vars: { equipos: "2 cocinas y una freidora", ciudad: "Trujillo", rubro: "restaurante" },
        turnCount: 1,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "complete", message: "¡Gracias! Un asesor te contactará." });
  });

  it("does NOT trust done:true alone — a required field still missing from vars keeps it going", () => {
    // The model claims done, but `ciudad` never actually landed in vars
    // (e.g. it hallucinated done without extracting it this turn or
    // any prior one) — vars is authoritative, not the model's self-report.
    const outcome = decideCollectAiOutcome({
      result: extractResult({ done: true, replyText: "¿En qué ciudad?" }),
      fields: FIELDS,
      vars: { equipos: "2 cocinas" },
      turnCount: 1,
      maxTurns: 6,
    });
    expect(outcome.kind).not.toBe("complete");
  });

  it("complete takes priority over max_turns exhaustion on the very last allowed turn", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ done: true, replyText: "Gracias." }),
        fields: FIELDS,
        vars: { equipos: "x", ciudad: "y", rubro: "z" },
        turnCount: 6,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "complete", message: "Gracias." });
  });

  it("handoff/max_turns_exhausted once turnCount reaches maxTurns without completing", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ replyText: "¿Algo más?" }),
        fields: FIELDS,
        vars: { equipos: "2 cocinas" },
        turnCount: 6,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "handoff", reason: "max_turns_exhausted" });
  });

  it("model_handoff takes priority over max_turns_exhaustion when both conditions hold", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ handoff: true, replyText: "" }),
        fields: FIELDS,
        vars: {},
        turnCount: 9,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "handoff", reason: "model_handoff", message: undefined });
  });

  it("handoff/empty_reply when not done, under the turn cap, but reply_text is blank", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ replyText: "   " }),
        fields: FIELDS,
        vars: {},
        turnCount: 1,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "handoff", reason: "empty_reply" });
  });

  it("continue with the trimmed reply_text otherwise", () => {
    expect(
      decideCollectAiOutcome({
        result: extractResult({ replyText: "  ¿En qué ciudad?  " }),
        fields: FIELDS,
        vars: { equipos: "2 cocinas" },
        turnCount: 1,
        maxTurns: 6,
      }),
    ).toEqual({ kind: "continue", message: "¿En qué ciudad?" });
  });
});

describe("shouldSendCollectAiNudge", () => {
  const BASE = {
    ageMinutes: 65,
    nudgeAfterMinutes: 60,
    lastAdvancedAt: "2026-01-01T10:00:00Z",
    lastNudgeSentAt: null as string | null,
    optedOut: false,
  };

  it("true once ageMinutes reaches nudgeAfterMinutes, with no prior nudge", () => {
    expect(shouldSendCollectAiNudge(BASE)).toBe(true);
  });

  it("false before the threshold", () => {
    expect(shouldSendCollectAiNudge({ ...BASE, ageMinutes: 59 })).toBe(false);
  });

  it("optedOut short-circuits to false regardless of everything else", () => {
    expect(
      shouldSendCollectAiNudge({ ...BASE, ageMinutes: 999, optedOut: true }),
    ).toBe(false);
  });

  it("false when a nudge was already sent for THIS silence period (nudge is after last_advanced_at)", () => {
    expect(
      shouldSendCollectAiNudge({
        ...BASE,
        lastNudgeSentAt: "2026-01-01T10:30:00Z", // after lastAdvancedAt (10:00)
      }),
    ).toBe(false);
  });

  it("true again once last_advanced_at moves past the old nudge — a reply resets eligibility with no explicit reset write", () => {
    expect(
      shouldSendCollectAiNudge({
        ...BASE,
        lastNudgeSentAt: "2026-01-01T09:00:00Z", // BEFORE lastAdvancedAt (10:00) — stale
        lastAdvancedAt: "2026-01-01T10:00:00Z",
        ageMinutes: 65, // 65 min since the NEW last_advanced_at
      }),
    ).toBe(true);
  });

  it("a nudge sent exactly at last_advanced_at does not count as covering this period (strict >)", () => {
    expect(
      shouldSendCollectAiNudge({
        ...BASE,
        lastNudgeSentAt: BASE.lastAdvancedAt,
      }),
    ).toBe(true);
  });
});

// ============================================================
// collect_ai orchestration — enterCollectAiNode / handleCollectAiReply,
// with extractWithReply (and its DB-touching neighbors) mocked so the
// control flow — turn counting, vars merging, continue/complete/
// handoff routing — is exercised without any real AI or Supabase call.
// ============================================================

function makeRun(overrides: Partial<FlowRunRow> = {}): FlowRunRow {
  return {
    id: "run-1",
    flow_id: "flow-1",
    account_id: "acct-1",
    user_id: "user-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    status: "active",
    current_node_key: "prev",
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    ai_turn_count: 0,
    last_nudge_sent_at: null,
    started_at: "2026-01-01T00:00:00Z",
    last_advanced_at: "2026-01-01T00:00:00Z",
    ended_at: null,
    end_reason: null,
    ...overrides,
  };
}

function makeNode(overrides: Partial<FlowNodeRow> = {}): FlowNodeRow {
  return {
    id: "node-1",
    flow_id: "flow-1",
    node_key: "collect",
    node_type: "collect_ai",
    config: {},
    position_x: 0,
    position_y: 0,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// Returned as Record<string, unknown> (not CollectAiNodeConfig) to
// match FlowNodeRow.config's actual storage type — mirrors how
// engine.ts itself reads `node.config as unknown as
// CollectAiNodeConfig` rather than storing it pre-typed.
function collectAiConfig(
  overrides: Partial<CollectAiNodeConfig> = {},
): Record<string, unknown> {
  const cfg: CollectAiNodeConfig = {
    fields: FIELDS,
    max_turns: 6,
    next_node_key: "done",
    ...overrides,
  };
  return cfg as unknown as Record<string, unknown>;
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: "openai",
    model: "gpt-test",
    apiKey: "sk-test",
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    transcribeAudioEnabled: false,
    ...overrides,
  };
}

/**
 * Minimal thenable Supabase-admin-client stand-in. Records every
 * `.update()`/`.insert()` call (table + payload) and resolves
 * `{data,error}` shaped closely enough to match every query shape
 * `resetAiTurnCount` / `incrementAiTurnCount` / `mergeCollectAiFields`
 * / `logEvent` / `endRun` / `advanceCurrentNodeKey` /
 * `executeHandoff`'s conversations update actually issue.
 * `advanceCurrentNodeKey`'s terminal `.select('id')` is the only read
 * that needs a non-empty result to signal "the UPDATE matched a row" —
 * `advanceSucceeds: false` simulates losing the optimistic-concurrency
 * race.
 */
function makeFakeDb(opts: { advanceSucceeds?: boolean } = {}) {
  const advanceSucceeds = opts.advanceSucceeds ?? true;
  const updates: { table: string; payload: Record<string, unknown> }[] = [];
  const inserts: { table: string; payload: Record<string, unknown> }[] = [];

  function from(table: string) {
    let mode: "update" | "select" | null = null;
    let selected = false;
    const chain = {
      update(payload: Record<string, unknown>) {
        mode = "update";
        updates.push({ table, payload });
        return chain;
      },
      insert(payload: Record<string, unknown>) {
        inserts.push({ table, payload });
        return Promise.resolve({ error: null });
      },
      select() {
        selected = true;
        return chain;
      },
      eq() {
        return chain;
      },
      is() {
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle() {
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        if (mode === "update" && selected) {
          resolve({ data: advanceSucceeds ? [{ id: "run-1" }] : [], error: null });
        } else {
          resolve({ data: null, error: null });
        }
      },
    };
    return chain;
  }

  return { db: { from } as never, updates, inserts };
}

const mockExtract = vi.mocked(extractWithReply);
const mockLoadAiConfig = vi.mocked(loadAiConfig);
const mockBuildContext = vi.mocked(buildConversationContext);
const mockSendText = vi.mocked(engineSendText);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAiConfig.mockResolvedValue(aiConfig());
  mockBuildContext.mockResolvedValue([{ role: "user", content: "hola" }]);
  mockSendText.mockResolvedValue({ whatsapp_message_id: "wamid.test" } as never);
});

describe("enterCollectAiNode", () => {
  it("with intro_text: sends it verbatim, never calls extractWithReply, and resets ai_turn_count", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 3 });
    const node = makeNode({ config: collectAiConfig({ intro_text: "¿Qué necesitas cotizar?" }) });

    const outcome = await enterCollectAiNode(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¿Qué necesitas cotizar?" }),
    );
    expect(run.ai_turn_count).toBe(0);
    expect(updates.some((u) => u.table === "flow_runs" && u.payload.ai_turn_count === 0)).toBe(true);
  });

  it("without intro_text: makes one opening extractWithReply call with no known values, sends its question", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });
    mockExtract.mockResolvedValue(
      extractResult({ replyText: "¿Qué equipos, en qué ciudad, y qué rubro?" }),
    );

    const outcome = await enterCollectAiNode(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockExtract.mock.calls[0][0]).toMatchObject({ knownValues: {} });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¿Qué equipos, en qué ciudad, y qué rubro?" }),
    );
    expect(run.ai_turn_count).toBe(1);
  });

  it("without intro_text: a one-shot opening reply that's already complete advances straight to next_node_key", async () => {
    // The "quiero cotizar 2 cocinas y una freidora en Trujillo, soy
    // restaurante" scenario — everything arrives in the trigger
    // message itself, so the FIRST call is already done:true.
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig({ next_node_key: "end" }) });
    const endNode = makeNode({ node_key: "end", node_type: "end", config: {} });
    mockExtract.mockResolvedValue(
      extractResult({
        fields: { equipos: "2 cocinas y una freidora", ciudad: "Trujillo", rubro: "restaurante" },
        done: true,
        replyText: "¡Gracias! Un asesor te contactará con la cotización.",
      }),
    );

    const outcome = await enterCollectAiNode(db, run, node, new Map([["end", endNode]]));

    expect(outcome).toEqual({ outcome: "completed" });
    expect(run.vars).toEqual({
      equipos: "2 cocinas y una freidora",
      ciudad: "Trujillo",
      rubro: "restaurante",
    });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¡Gracias! Un asesor te contactará con la cotización." }),
    );
  });
});

describe("handleCollectAiReply", () => {
  it("merges only newly-extracted fields — never overwrites an already-captured one with an absent extraction", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ vars: { ciudad: "Trujillo" } });
    const node = makeNode({ config: collectAiConfig() });
    mockExtract.mockResolvedValue(
      extractResult({ fields: { equipos: "2 cocinas" }, replyText: "¿A qué rubro pertenece?" }),
    );

    await handleCollectAiReply(db, run, node, new Map());

    expect(run.vars).toEqual({ ciudad: "Trujillo", equipos: "2 cocinas" });
    // The prompt must have been told ciudad is already known so it
    // doesn't ask about it again.
    expect(mockExtract.mock.calls[0][0]).toMatchObject({ knownValues: { ciudad: "Trujillo" } });
  });

  it("increments ai_turn_count by one per call", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 2 });
    const node = makeNode({ config: collectAiConfig() });
    mockExtract.mockResolvedValue(extractResult());

    await handleCollectAiReply(db, run, node, new Map());

    expect(run.ai_turn_count).toBe(3);
  });

  it("done + all required fields present advances to next_node_key and sends the closing line", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ vars: { equipos: "2 cocinas", ciudad: "Trujillo" } });
    const node = makeNode({ config: collectAiConfig({ next_node_key: "end" }) });
    const endNode = makeNode({ node_key: "end", node_type: "end", config: {} });
    mockExtract.mockResolvedValue(
      extractResult({ fields: { rubro: "restaurante" }, done: true, replyText: "¡Listo, gracias!" }),
    );

    const outcome = await handleCollectAiReply(db, run, node, new Map([["end", endNode]]));

    expect(outcome).toEqual({ outcome: "completed" });
    expect(run.vars.rubro).toBe("restaurante");
    expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({ text: "¡Listo, gracias!" }));
  });

  it("max_turns exhausted without done routes to handoff_node_key, carrying partial vars along", async () => {
    const { db, inserts } = makeFakeDb();
    const run = makeRun({ vars: { equipos: "2 cocinas" }, ai_turn_count: 5 });
    const node = makeNode({
      config: collectAiConfig({ max_turns: 6, handoff_node_key: "human" }),
    });
    const handoffNode = makeNode({
      node_key: "human",
      node_type: "handoff",
      config: { note: "AI collector exhausted" },
    });
    mockExtract.mockResolvedValue(extractResult({ replyText: "¿Y la ciudad?" }));

    const outcome = await handleCollectAiReply(db, run, node, new Map([["human", handoffNode]]));

    expect(outcome).toEqual({ outcome: "handed_off" });
    expect(run.ai_turn_count).toBe(6);
    expect(run.vars).toEqual({ equipos: "2 cocinas" }); // partial vars preserved
    expect(
      inserts.some(
        (i) => i.table === "flow_run_events" && i.payload.event_type === "handoff",
      ),
    ).toBe(true);
  });

  it("max_turns exhausted with no handoff_node_key configured falls back to the generic pending-conversation handoff", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 6 });
    const node = makeNode({ config: collectAiConfig({ max_turns: 6 }) }); // no handoff_node_key
    mockExtract.mockResolvedValue(extractResult({ replyText: "¿Algo más?" }));

    const outcome = await handleCollectAiReply(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "handed_off" });
    expect(
      updates.some((u) => u.table === "conversations" && u.payload.status === "pending"),
    ).toBe(true);
    expect(
      updates.some((u) => u.table === "flow_runs" && u.payload.status === "handed_off"),
    ).toBe(true);
  });

  it("model handoff:true sends the courtesy message then hands off immediately, ignoring max_turns", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 1 });
    const node = makeNode({ config: collectAiConfig({ max_turns: 6 }) });
    mockExtract.mockResolvedValue(
      extractResult({ handoff: true, replyText: "Ok, te comunico con un asesor." }),
    );

    const outcome = await handleCollectAiReply(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "handed_off" });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Ok, te comunico con un asesor." }),
    );
  });

  it("a provider failure (extractWithReply throws) hands off instead of throwing or stranding the customer", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });
    mockExtract.mockRejectedValue(new Error("timeout"));

    const outcome = await handleCollectAiReply(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "handed_off" });
    expect(mockSendText).not.toHaveBeenCalled(); // no handoff_fallback_text configured — stays silent, as before
  });

  it("a provider failure sends handoff_fallback_text when the node configured one", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({
      config: collectAiConfig({
        handoff_fallback_text: "Un asesor te va a contactar en breve para ayudarte con tu cotización.",
      }),
    });
    mockExtract.mockRejectedValue(new Error("timeout"));

    const outcome = await handleCollectAiReply(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "handed_off" });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Un asesor te va a contactar en breve para ayudarte con tu cotización.",
      }),
    );
  });

  it("max_turns exhaustion sends handoff_fallback_text too, not just provider errors", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 5 });
    const node = makeNode({
      config: collectAiConfig({ max_turns: 6, handoff_fallback_text: "Un asesor te contactará pronto." }),
    });
    mockExtract.mockResolvedValue(extractResult({ replyText: "¿Y la ciudad?" }));

    await handleCollectAiReply(db, run, node, new Map());

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Un asesor te contactará pronto." }),
    );
  });

  it("prefers the model's own courtesy message over handoff_fallback_text when both are available", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({
      config: collectAiConfig({ handoff_fallback_text: "Texto genérico del nodo." }),
    });
    mockExtract.mockResolvedValue(
      extractResult({ handoff: true, replyText: "Puntual: te comunico con un asesor ya mismo." }),
    );

    await handleCollectAiReply(db, run, node, new Map());

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Puntual: te comunico con un asesor ya mismo." }),
    );
    expect(mockSendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "Texto genérico del nodo." }),
    );
  });

  it("no AI config for the account hands off instead of throwing", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });
    mockLoadAiConfig.mockResolvedValue(null);

    const outcome = await handleCollectAiReply(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "handed_off" });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("logs token spend under its own 'flow_collect' mode, distinct from auto_reply/draft", async () => {
    const { db, inserts } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });
    mockExtract.mockResolvedValue({
      ...extractResult(),
      usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
    });

    await handleCollectAiReply(db, run, node, new Map());
    // logAiUsage is fire-and-forget (void, not awaited) inside
    // runCollectAiTurn — flush the microtask queue so its insert lands
    // before asserting.
    await new Promise((r) => setTimeout(r, 0));

    const usageInsert = inserts.find((i) => i.table === "ai_usage_log");
    expect(usageInsert?.payload).toMatchObject({
      mode: "flow_collect",
      account_id: "acct-1",
      conversation_id: "conv-1",
      total_tokens: 160,
    });
  });

  it("does not log usage when the provider reported none", async () => {
    const { db, inserts } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });
    mockExtract.mockResolvedValue(extractResult()); // usage: null

    await handleCollectAiReply(db, run, node, new Map());
    await new Promise((r) => setTimeout(r, 0));

    expect(inserts.some((i) => i.table === "ai_usage_log")).toBe(false);
  });
});

describe("handleCollectAiNonTextReply", () => {
  it("sends the built-in default when the node has no non_text_reply_text configured, without calling extractWithReply", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() }); // no non_text_reply_text

    const outcome = await handleCollectAiNonTextReply(db, run, node);

    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
      }),
    );
  });

  it("sends the node's configured non_text_reply_text instead of the default when set", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({
      config: collectAiConfig({ non_text_reply_text: "Por ahora no puedo ver fotos, ¿me lo contás en texto?" }),
    });

    await handleCollectAiNonTextReply(db, run, node);

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Por ahora no puedo ver fotos, ¿me lo contás en texto?" }),
    );
  });

  it("never spends a turn — ai_turn_count is untouched", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 2 });
    const node = makeNode({ config: collectAiConfig() });

    await handleCollectAiNonTextReply(db, run, node);

    expect(run.ai_turn_count).toBe(2);
  });

  it("stays suspended on the same node (does not advance or complete)", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ current_node_key: "collect" });
    const node = makeNode({ node_key: "collect", config: collectAiConfig() });

    const outcome = await handleCollectAiNonTextReply(db, run, node);

    expect(outcome).toEqual({ outcome: "advanced" });
    expect(
      updates.some(
        (u) => u.table === "flow_runs" && u.payload.current_node_key === "collect",
      ),
    ).toBe(true);
  });
});
