import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocked BEFORE importing ./engine so its module-level import binds to
// these mocks — engine.ts calls extractWithReply/loadAiConfig/
// buildConversationContext/engineSendText as plain function imports,
// so replacing the modules is enough (no DI needed in engine.ts).
vi.mock("@/lib/ai/generate", () => ({ extractWithReply: vi.fn() }));
vi.mock("@/lib/ai/config", () => ({ loadAiConfig: vi.fn() }));
vi.mock("@/lib/ai/context", () => ({ buildConversationContext: vi.fn() }));
vi.mock("@/lib/ai/inbound-audio", () => ({ transcribeInboundAudio: vi.fn() }));
vi.mock("@/lib/ai/classify-first-inbound", () => ({
  classifyFirstInboundContext: vi.fn(),
}));
vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  engineSendMedia: vi.fn(),
}));

// Only dispatchInboundToFlows (and startFlowRunAtNode, untested today)
// call supabaseAdmin() internally rather than taking `db` as a
// parameter — every other exported function under test gets its fake
// db injected directly, so this mock is inert for the rest of the file.
const adminDbHolder: { current: unknown } = { current: null };
vi.mock("./admin-client", () => ({
  supabaseAdmin: () => adminDbHolder.current,
}));

import {
  matchReplyId,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isValidCollectInputValue,
  isTerminal,
  evaluateConditionPredicate,
  isConversationBotEligible,
  decideCollectAiOutcome,
  collectAiRequiredFieldsPresent,
  enterCollectAiNode,
  handleCollectAiReply,
  handleCollectAiNonTextReply,
  handleCollectAiBlankReply,
  handleReplyForActiveRun,
  shouldSendInactivityNudge,
  resolveTemplateButtonAction,
  findEntryFlow,
  dispatchInboundToFlows,
} from "./engine";
import { extractWithReply } from "@/lib/ai/generate";
import { loadAiConfig } from "@/lib/ai/config";
import { buildConversationContext } from "@/lib/ai/context";
import { transcribeInboundAudio } from "@/lib/ai/inbound-audio";
import { classifyFirstInboundContext } from "@/lib/ai/classify-first-inbound";
import {
  engineSendText,
  engineSendMedia,
  engineSendInteractiveList,
  engineSendInteractiveButtons,
} from "./meta-send";
import type { AiConfig } from "@/lib/ai/types";
import type {
  CollectAiNodeConfig,
  FlowNodeRow,
  FlowRunRow,
  FlowRow,
  ParsedInbound,
} from "./types";

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

  describe("match_type='word'", () => {
    const cfg = { keywords: ["menu", "menú"], match_type: "word" as const };

    it("matches the bare word", () => {
      expect(matchesKeywordTrigger("menú", cfg)).toBe(true);
      expect(matchesKeywordTrigger("Menu", cfg)).toBe(true);
    });

    it("matches the word inside a real sentence", () => {
      expect(matchesKeywordTrigger("quiero el menú", cfg)).toBe(true);
      expect(matchesKeywordTrigger("muéstrame el menú", cfg)).toBe(true);
      expect(matchesKeywordTrigger("No deseo ver el catálogo, quiero el menú", cfg)).toBe(true);
    });

    it("does not match when the keyword is embedded inside a longer word", () => {
      expect(matchesKeywordTrigger("quiero pedir un menudo", cfg)).toBe(false);
      expect(matchesKeywordTrigger("menudencia", cfg)).toBe(false);
    });

    it("matches at the very start or end of the message (no boundary character needed there)", () => {
      expect(matchesKeywordTrigger("menú!", cfg)).toBe(true);
      expect(matchesKeywordTrigger("¡menú", cfg)).toBe(true);
    });
  });

  describe("accent-insensitive matching", () => {
    it("contains: an accented keyword matches the unaccented customer text and vice versa", () => {
      expect(
        matchesKeywordTrigger("cuanto cuesta la cotizacion", {
          keywords: ["cotización"],
        }),
      ).toBe(true);
      expect(
        matchesKeywordTrigger("necesito una cotización", {
          keywords: ["cotizacion"],
        }),
      ).toBe(true);
    });

    it("word match_type also folds accents on both sides", () => {
      const cfg = { keywords: ["menu"], match_type: "word" as const };
      expect(matchesKeywordTrigger("quiero el menú", cfg)).toBe(true);
    });

    it("exact match_type also folds accents", () => {
      expect(
        matchesKeywordTrigger("cotizacion", {
          keywords: ["cotización"],
          match_type: "exact",
        }),
      ).toBe(true);
    });

    it("case_sensitive configs do NOT fold accents — an exact byte match is still required", () => {
      expect(
        matchesKeywordTrigger("cotizacion", {
          keywords: ["cotización"],
          case_sensitive: true,
        }),
      ).toBe(false);
    });
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

describe("isValidCollectInputValue", () => {
  it("'any' (or unset) accepts anything non-empty — the original v1.5 behavior", () => {
    expect(isValidCollectInputValue("any", "cualquier cosa")).toBe(true);
    expect(isValidCollectInputValue(undefined, "cualquier cosa")).toBe(true);
  });

  it("'phone' accepts exactly 9 digits, with or without spaces as separators", () => {
    expect(isValidCollectInputValue("phone", "987654321")).toBe(true);
    expect(isValidCollectInputValue("phone", "987 654 321")).toBe(true);
  });

  it("'phone' rejects too few/too many digits, letters, or a country code prefix", () => {
    expect(isValidCollectInputValue("phone", "98765")).toBe(false);
    expect(isValidCollectInputValue("phone", "9876543210")).toBe(false);
    expect(isValidCollectInputValue("phone", "987abc321")).toBe(false);
    expect(isValidCollectInputValue("phone", "+51987654321")).toBe(false);
    expect(isValidCollectInputValue("phone", "")).toBe(false);
  });

  it("'email' accepts a plausible x@y.z shape and rejects the obvious non-matches", () => {
    expect(isValidCollectInputValue("email", "cliente@sagama.pe")).toBe(true);
    expect(isValidCollectInputValue("email", "no es un correo")).toBe(false);
    expect(isValidCollectInputValue("email", "falta-arroba.com")).toBe(false);
  });

  it("'regex' tests the value against the configured pattern", () => {
    expect(isValidCollectInputValue("regex", "ABC-123", "^[A-Z]{3}-\\d{3}$")).toBe(true);
    expect(isValidCollectInputValue("regex", "abc123", "^[A-Z]{3}-\\d{3}$")).toBe(false);
  });

  it("'regex' with no pattern configured, or a malformed one, fails OPEN — accepts the value", () => {
    expect(isValidCollectInputValue("regex", "cualquier cosa", undefined)).toBe(true);
    expect(isValidCollectInputValue("regex", "cualquier cosa", "(unterminated[")).toBe(true);
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
  it("eligible when unassigned", () => {
    expect(isConversationBotEligible({ assigned_agent_id: null })).toBe(true);
  });

  it("eligible when 'pending' but unassigned — a handoff nobody picked up must not strand the customer", () => {
    expect(isConversationBotEligible({ assigned_agent_id: null })).toBe(true);
  });

  it("not eligible once an agent has actually claimed it", () => {
    expect(isConversationBotEligible({ assigned_agent_id: "agent-1" })).toBe(false);
  });

  it("fails open (eligible) when the conversation lookup came back null", () => {
    // Mirrors this file's existing convention for DB read failures on
    // guard checks: a transient error shouldn't silently mute every
    // flow trigger for the account.
    expect(isConversationBotEligible(null)).toBe(true);
  });
});

// ============================================================
// findEntryFlow — reentry_keywords
// ============================================================

/** Minimal fake db for findEntryFlow: only needs to serve the
 *  `.from("flows").select().eq().eq().order()` chain used to load the
 *  account's active flows. */
function makeFlowsFakeDb(flows: Partial<FlowRow>[]) {
  return {
    from: (table: string) => {
      if (table !== "flows") throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => Promise.resolve({ data: flows, error: null }),
      };
      return chain;
    },
  } as never;
}

function textMessage(text: string): ParsedInbound {
  return { kind: "text", text, meta_message_id: "wamid.test" };
}

const FAQ_BOT_FLOW: Partial<FlowRow> = {
  id: "flow-faq",
  account_id: "acct-1",
  status: "active",
  trigger_type: "first_inbound_message",
  trigger_config: { reentry_keywords: ["menu", "menú"] },
  entry_node_id: "start",
};

describe("findEntryFlow — reentry_keywords", () => {
  beforeEach(() => {
    // Safe default for every test in this block: "no context detected"
    // — matches today's behavior (show the menu) and mirrors the real
    // classifier's own fail-open default. Tests that specifically
    // exercise the "has context" branch override this per-call.
    vi.mocked(classifyFirstInboundContext).mockResolvedValue({
      hasContext: false,
      reason: "default test stub",
    });
  });

  it("matches a flow whose primary trigger_type did NOT fire, via reentry_keywords", async () => {
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    // isFirstInbound: false — first_inbound_message would never match on
    // its own; only reentry_keywords should.
    const flow = await findEntryFlow(db, "acct-1", "conv-1", textMessage("menú"), false);
    expect(flow?.id).toBe("flow-faq");
  });

  it("is case-insensitive", async () => {
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    const flow = await findEntryFlow(db, "acct-1", "conv-1", textMessage("MENU"), false);
    expect(flow?.id).toBe("flow-faq");
  });

  it("matches as a whole word inside a real sentence — 'quiero el menú', not just the bare word", async () => {
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    const flow = await findEntryFlow(
      db,
      "acct-1",
      "conv-1",
      textMessage("No deseo ver el catálogo, quiero el menú"),
      false,
    );
    expect(flow?.id).toBe("flow-faq");
  });

  it("does not match a keyword embedded inside an unrelated longer word", async () => {
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    const flow = await findEntryFlow(
      db,
      "acct-1",
      "conv-1",
      textMessage("Quiero pedir un menudo"),
      false,
    );
    expect(flow).toBeNull();
  });

  it("does nothing when the flow has no reentry_keywords configured (no regression)", async () => {
    const db = makeFlowsFakeDb([{ ...FAQ_BOT_FLOW, trigger_config: {} }]);
    const flow = await findEntryFlow(db, "acct-1", "conv-1", textMessage("menú"), false);
    expect(flow).toBeNull();
  });

  it("falls through to the normal trigger_type loop when no reentry match", async () => {
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    // isFirstInbound: true — should match via the primary trigger_type
    // instead, for an unrelated message.
    const flow = await findEntryFlow(db, "acct-1", "conv-1", textMessage("hola"), true);
    expect(flow?.id).toBe("flow-faq");
  });
});

// ============================================================
// findEntryFlow — first-inbound context classification
// ============================================================

const KEYWORD_FLOW: Partial<FlowRow> = {
  id: "flow-keyword",
  account_id: "acct-1",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["cotizar"] },
  entry_node_id: "start",
};

describe("findEntryFlow — first-inbound context classification", () => {
  it("skips first_inbound_message (continue, not return) when the classifier finds context, so a later keyword flow can still match", async () => {
    vi.mocked(classifyFirstInboundContext).mockResolvedValue({
      hasContext: true,
      reason: "mentions a specific product and city",
    });
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW, KEYWORD_FLOW]);
    const flow = await findEntryFlow(
      db,
      "acct-1",
      "conv-1",
      textMessage("Necesito cotizar una cocina para mi restaurante en Trujillo"),
      true,
    );
    // FAQ_BOT_FLOW (first_inbound_message) is skipped; KEYWORD_FLOW
    // still matches independently on "cotizar".
    expect(flow?.id).toBe("flow-keyword");
  });

  it("skips first_inbound_message entirely (no other flow to fall back to) when the classifier finds context", async () => {
    vi.mocked(classifyFirstInboundContext).mockResolvedValue({
      hasContext: true,
      reason: "mentions a specific product",
    });
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    const flow = await findEntryFlow(
      db,
      "acct-1",
      "conv-1",
      textMessage("Necesito cotizar una cocina industrial"),
      true,
    );
    // No flow matches — dispatchInboundToFlows reports no_match and the
    // webhook falls through to the general assistant.
    expect(flow).toBeNull();
  });

  it("matches first_inbound_message normally when the classifier finds no context", async () => {
    vi.mocked(classifyFirstInboundContext).mockResolvedValue({
      hasContext: false,
      reason: "generic greeting",
    });
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    const flow = await findEntryFlow(db, "acct-1", "conv-1", textMessage("Hola, buenas"), true);
    expect(flow?.id).toBe("flow-faq");
  });

  it("never calls the classifier when isFirstInbound is false", async () => {
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    await findEntryFlow(db, "acct-1", "conv-1", textMessage("Necesito cotizar una cocina"), false);
    expect(classifyFirstInboundContext).not.toHaveBeenCalled();
  });

  it("never calls the classifier for a keyword-only flow set (no first_inbound_message flow in play)", async () => {
    const db = makeFlowsFakeDb([KEYWORD_FLOW]);
    await findEntryFlow(db, "acct-1", "conv-1", textMessage("quiero cotizar"), true);
    expect(classifyFirstInboundContext).not.toHaveBeenCalled();
  });

  it("classifies at most once even if more than one active flow uses first_inbound_message", async () => {
    vi.mocked(classifyFirstInboundContext).mockResolvedValue({
      hasContext: false,
      reason: "generic",
    });
    const db = makeFlowsFakeDb([
      FAQ_BOT_FLOW,
      { ...FAQ_BOT_FLOW, id: "flow-faq-2" },
    ]);
    await findEntryFlow(db, "acct-1", "conv-1", textMessage("Hola"), true);
    expect(classifyFirstInboundContext).toHaveBeenCalledTimes(1);
  });

  it("propagates a provider/timeout failure as hasContext:false (fail-open), matching the real classifier's own contract", async () => {
    // The real classifyFirstInboundContext never throws — this mock
    // exercises the same fail-open VALUE its own try/catch would return
    // on a provider error or timeout, since findEntryFlow's job is just
    // to trust whatever the classifier returns.
    vi.mocked(classifyFirstInboundContext).mockResolvedValue({
      hasContext: false,
      reason: "provider call failed or timed out",
    });
    const db = makeFlowsFakeDb([FAQ_BOT_FLOW]);
    const flow = await findEntryFlow(
      db,
      "acct-1",
      "conv-1",
      textMessage("Necesito cotizar una cocina"),
      true,
    );
    expect(flow?.id).toBe("flow-faq");
  });
});

// ============================================================
// dispatchInboundToFlows — 'pending' no longer blocks eligibility
// (Bug B follow-up): only an actually-claimed conversation
// (assigned_agent_id set) blocks a flow from restarting. A conversation
// merely 'pending' — a handoff nobody has picked up yet — must let the
// bot re-engage normally through the ordinary findEntryFlow path.
// ============================================================

/**
 * Generic Supabase-style chain: every intermediate call (.select/.eq/
 * .order/.limit) returns the same object, so it supports both an
 * explicit terminal (.maybeSingle()) and being awaited directly
 * (.then()) — whichever pattern the real code under test happens to
 * use for that table.
 */
function reentryChain(terminal: () => Promise<{ data: unknown; error: unknown; count?: number }>) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    is: () => obj,
    gte: () => obj,
    order: () => obj,
    limit: () => obj,
    maybeSingle: () => terminal(),
    then: (resolve: (v: { data: unknown; error: unknown; count?: number }) => void) =>
      terminal().then(resolve),
  };
  return obj;
}

function makeReentryOverrideFakeDb(opts: {
  conversationGate: { assigned_agent_id: string | null } | null;
  flows: Partial<FlowRow>[];
  flowNodes: Partial<FlowNodeRow>[];
  priorRunCount?: number;
  contactState?: { known_vars?: Record<string, unknown>; selected_options?: Record<string, string[]> };
  /** Makes `wasHandedOffRecently` resolve true for every conversation —
   *  simulates a `flow_run_events` "handoff" row already logged within
   *  the cooldown window. */
  recentHandoffExists?: boolean;
}) {
  const conversationUpdates: Record<string, unknown>[] = [];
  const flowRunInserts: Record<string, unknown>[] = [];
  const flowRunEventInserts: Record<string, unknown>[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];

  const db = {
    from: (table: string) => {
      if (table === "flow_runs") {
        return {
          ...reentryChain(() =>
            Promise.resolve({ data: [], error: null, count: opts.priorRunCount ?? 0 }),
          ), // no ACTIVE run; count doubles as the is_reentry prior-run tally
          insert: (payload: Record<string, unknown>) => {
            flowRunInserts.push(payload);
            return reentryChain(() =>
              Promise.resolve({ data: { id: "run-new", ...payload }, error: null }),
            );
          },
          update: () =>
            reentryChain(() => Promise.resolve({ data: [{ id: "run-1" }], error: null })),
        };
      }
      if (table === "conversations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.conversationGate, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            conversationUpdates.push(payload);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      if (table === "flows") {
        return reentryChain(() => Promise.resolve({ data: opts.flows, error: null }));
      }
      if (table === "flow_nodes") {
        return reentryChain(() => Promise.resolve({ data: opts.flowNodes, error: null }));
      }
      if (table === "flow_run_events") {
        return {
          insert: (payload: Record<string, unknown>) => {
            flowRunEventInserts.push(payload);
            return Promise.resolve({ error: null });
          },
          // wasHandedOffRecently's read — see its own doc comment.
          ...reentryChain(() =>
            Promise.resolve({
              data: opts.recentHandoffExists ? [{ id: "evt-recent-handoff" }] : [],
              error: null,
            }),
          ),
        };
      }
      if (table === "flow_contact_state") {
        const stateData = opts.contactState
          ? {
              known_vars: opts.contactState.known_vars ?? {},
              selected_options: opts.contactState.selected_options ?? {},
            }
          : null;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: stateData, error: null }) }),
              maybeSingle: () => Promise.resolve({ data: stateData, error: null }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in reentry-override test: ${table}`);
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { db, conversationUpdates, flowRunInserts, flowRunEventInserts, rpcCalls };
}

const FAQ_FLOW_ENDING_IMMEDIATELY: Partial<FlowRow> = {
  id: "flow-faq",
  account_id: "acct-1",
  status: "active",
  trigger_type: "first_inbound_message",
  trigger_config: { reentry_keywords: ["menu", "menú"] },
  entry_node_id: "end", // reaches a terminal node in one step — no Meta sends needed
};
const END_NODE: Partial<FlowNodeRow> = { node_key: "end", node_type: "end", config: {} };

function reentryInput(text: string) {
  return {
    accountId: "acct-1",
    userId: "user-1",
    contactId: "contact-1",
    conversationId: "conv-1",
    message: { kind: "text" as const, text, meta_message_id: "wamid.reentry" },
    isFirstInboundMessage: false,
  };
}

describe("dispatchInboundToFlows — pending-but-unclaimed no longer blocks entry triggers", () => {
  it("'menú' restarts the flow when pending with nobody assigned — and resets the conversation off 'pending'", async () => {
    const { db, conversationUpdates, flowRunInserts } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FAQ_FLOW_ENDING_IMMEDIATELY],
      flowNodes: [END_NODE],
      priorRunCount: 1, // this contact has run this flow before — a reentry
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(reentryInput("menú"));

    expect(result.consumed).toBe(true);
    expect(flowRunInserts).toHaveLength(1);
    // insertAndAdvanceRun resets the conversation off any stale
    // pending/disabled state left over from the prior handoff.
    expect(
      conversationUpdates.some((u) => u.status === "open" && u.ai_autoreply_disabled === false),
    ).toBe(true);
    // vars.is_reentry drives reentry_text — see SendListNodeConfig.
    expect(flowRunInserts[0].vars).toEqual({ is_reentry: true });
  });

  it("does NOT restart when an agent has actually claimed the thread, even for 'menú'", async () => {
    const { db, conversationUpdates, flowRunInserts } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: "agent-1" },
      flows: [FAQ_FLOW_ENDING_IMMEDIATELY],
      flowNodes: [END_NODE],
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(reentryInput("menú"));

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(flowRunInserts).toHaveLength(0);
    expect(conversationUpdates).toHaveLength(0);
  });

  it("a genuinely unrelated message does not restart the flow, and leaves the conversation untouched", async () => {
    const { db, conversationUpdates, flowRunInserts } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FAQ_FLOW_ENDING_IMMEDIATELY],
      flowNodes: [END_NODE],
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(reentryInput("Esta bien en a qué hora?"));

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(flowRunInserts).toHaveLength(0);
    expect(conversationUpdates).toHaveLength(0);
  });
});

describe("dispatchInboundToFlows — orphaned interactive tap with no active run (stale/scrolled-up button)", () => {
  function tapInput(replyId: string) {
    return {
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: {
        kind: "interactive_reply" as const,
        reply_id: replyId,
        reply_title: "X",
        meta_message_id: "wamid.tap",
      },
      isFirstInboundMessage: false,
    };
  }

  it("sends the already-handled notice and hands off, instead of falling through to the general assistant", async () => {
    const { db, conversationUpdates } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [],
      flowNodes: [],
      contactState: { selected_options: { topics: ["catalog", "quote_inox"] } },
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(tapInput("catalog"));

    expect(result).toEqual({ consumed: true, outcome: "already_selected_notice" });
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Ya te habíamos compartido"),
      }),
    );
    expect(
      conversationUpdates.some(
        (u) => u.status === "pending" && u.ai_autoreply_disabled === true,
      ),
    ).toBe(true);
  });

  it("a tap that doesn't match any recorded selected_options still gets a visible, honest reply instead of total silence — never falls through to no_match", async () => {
    const { db, conversationUpdates } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [],
      flowNodes: [],
      contactState: { selected_options: { topics: ["catalog"] } },
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(tapInput("quote_inox"));

    expect(result).toEqual({ consumed: true, outcome: "stale_interactive_notice" });
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Ya tenemos tus datos"),
      }),
    );
    expect(
      conversationUpdates.some(
        (u) => u.status === "pending" && u.ai_autoreply_disabled === true,
      ),
    ).toBe(true);
  });

  it("a contact with no flow_contact_state row at all still gets a reply (never throws, never silent)", async () => {
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [],
      flowNodes: [],
      // no contactState passed — fakeDb returns a null row, same as a real miss
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(tapInput("catalog"));

    expect(result).toEqual({ consumed: true, outcome: "stale_interactive_notice" });
    expect(engineSendText).toHaveBeenCalled();
  });

  it("an agent-owned conversation is left alone even for a re-tap of an already-handled option", async () => {
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: "agent-1" },
      flows: [],
      flowNodes: [],
      contactState: { selected_options: { topics: ["catalog"] } },
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(tapInput("catalog"));

    expect(result).toEqual({ consumed: false, outcome: "no_match" });
    expect(engineSendText).not.toHaveBeenCalled();
  });
});

describe("send_list / send_buttons — reentry_text (skip the welcome banner on a re-trigger)", () => {
  // reentry_keywords is what's actually deployed today (see the "menú"
  // reentry work) — trigger_type stays first_inbound_message so the
  // "first ever" test below matches the same way FAQ bot really does.
  const FLOW_WITH_TOPICS: Partial<FlowRow> = {
    id: "flow-faq",
    account_id: "acct-1",
    status: "active",
    trigger_type: "first_inbound_message",
    trigger_config: { reentry_keywords: ["menu", "menú"] },
    entry_node_id: "topics",
  };
  const TOPICS_LIST_NODE: Partial<FlowNodeRow> = {
    node_key: "topics",
    node_type: "send_list",
    config: {
      text: "—x9 ¡Bienvenido a Sagama Inox!",
      reentry_text: "Estas son las opciones disponibles —x!",
      button_label: "Ver opciones",
      sections: [{ rows: [{ reply_id: "a", title: "A" }] }],
    },
  };

  beforeEach(() => {
    vi.mocked(engineSendInteractiveList).mockResolvedValue({
      whatsapp_message_id: "wamid.list",
    } as never);
  });

  it("first-ever run (no prior runs of this flow): uses the full welcome text, not reentry_text", async () => {
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_TOPICS],
      flowNodes: [TOPICS_LIST_NODE],
      priorRunCount: 0,
    });
    adminDbHolder.current = db;

    await dispatchInboundToFlows({ ...reentryInput("Hola"), isFirstInboundMessage: true });

    expect(engineSendInteractiveList).toHaveBeenCalledWith(
      expect.objectContaining({ bodyText: "—x9 ¡Bienvenido a Sagama Inox!" }),
    );
  });

  it("a reentry via 'menú' (this contact already ran this flow before): uses reentry_text instead", async () => {
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_TOPICS],
      flowNodes: [TOPICS_LIST_NODE],
      priorRunCount: 1,
    });
    adminDbHolder.current = db;

    await dispatchInboundToFlows(reentryInput("menú"));

    expect(engineSendInteractiveList).toHaveBeenCalledWith(
      expect.objectContaining({ bodyText: "Estas son las opciones disponibles —x!" }),
    );
  });

  it("a reentry with no reentry_text configured falls back to the normal text, unchanged", async () => {
    const nodeWithoutReentryText: Partial<FlowNodeRow> = {
      ...TOPICS_LIST_NODE,
      config: { ...(TOPICS_LIST_NODE.config as object), reentry_text: undefined },
    };
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_TOPICS],
      flowNodes: [nodeWithoutReentryText],
      priorRunCount: 1,
    });
    adminDbHolder.current = db;

    await dispatchInboundToFlows(reentryInput("menú"));

    expect(engineSendInteractiveList).toHaveBeenCalledWith(
      expect.objectContaining({ bodyText: "—x9 ¡Bienvenido a Sagama Inox!" }),
    );
  });
});

describe("send_list — flow_contact_state option exclusion (never show the same option twice)", () => {
  const FLOW_WITH_TOPICS: Partial<FlowRow> = {
    id: "flow-faq",
    account_id: "acct-1",
    status: "active",
    trigger_type: "first_inbound_message",
    trigger_config: { reentry_keywords: ["menu", "menú"] },
    entry_node_id: "topics",
  };
  const TWO_OPTION_LIST_NODE: Partial<FlowNodeRow> = {
    node_key: "topics",
    node_type: "send_list",
    config: {
      text: "—x9 ¡Bienvenido!",
      reentry_text: "Seguí explorando —x!",
      button_label: "Ver opciones",
      all_selected_node_key: "human_handoff",
      sections: [
        {
          rows: [
            { reply_id: "catalog", title: "Catálogo", next_node_key: "answer_catalog" },
            { reply_id: "location", title: "Ubicación", next_node_key: "answer_location" },
          ],
        },
      ],
    },
  };

  beforeEach(() => {
    vi.mocked(engineSendInteractiveList).mockResolvedValue({
      whatsapp_message_id: "wamid.list",
    } as never);
  });

  it("excludes an option this contact already picked in a prior run", async () => {
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_TOPICS],
      flowNodes: [TWO_OPTION_LIST_NODE],
      priorRunCount: 1,
      contactState: { selected_options: { topics: ["catalog"] } },
    });
    adminDbHolder.current = db;

    await dispatchInboundToFlows(reentryInput("menú"));

    expect(engineSendInteractiveList).toHaveBeenCalledWith(
      expect.objectContaining({
        sections: [{ title: undefined, rows: [{ id: "location", title: "Ubicación", description: undefined }] }],
      }),
    );
  });

  it("redirects to all_selected_node_key instead of sending anything once every option is gone — and the handoff node itself still sends a real, visible message the first time", async () => {
    const humanHandoffNode: Partial<FlowNodeRow> = {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {},
    };
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_TOPICS],
      flowNodes: [TWO_OPTION_LIST_NODE, humanHandoffNode],
      priorRunCount: 1,
      contactState: { selected_options: { topics: ["catalog", "location"] } },
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(reentryInput("menú"));

    expect(engineSendInteractiveList).not.toHaveBeenCalled();
    expect(result.outcome).toBe("handed_off");
    // The customer never saw the exhausted menu, but must still get a
    // real, visible acknowledgment from the handoff node itself — not
    // total silence. No recent handoff logged yet, so this is not a
    // duplicate.
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Gracias, un asesor va a continuar tu consulta en breve." }),
    );
  });

  it("a SECOND menu-exhausted handoff within the cooldown window skips the repeated customer message, but still leaves the conversation correctly pending, and still logs it", async () => {
    const humanHandoffNode: Partial<FlowNodeRow> = {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {},
    };
    const { db, conversationUpdates, flowRunEventInserts } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_TOPICS],
      flowNodes: [TWO_OPTION_LIST_NODE, humanHandoffNode],
      priorRunCount: 1,
      contactState: { selected_options: { topics: ["catalog", "location"] } },
      // Simulates the exact real-world sequence: this contact already
      // has a `handoff` flow_run_event logged moments ago from an
      // earlier run — e.g. they already tapped "hablar con un asesor"
      // and just sent another message (any reentry-triggering text)
      // while still queued for a human.
      recentHandoffExists: true,
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(reentryInput("menú"));

    expect(result.outcome).toBe("handed_off");
    // No duplicate "Gracias, un asesor..." spam on this repeat.
    expect(mockSendText).not.toHaveBeenCalled();
    // The conversation still ends up back in the correct pending state
    // (a NEW run unconditionally resets it to "open" at the very start
    // — see insertAndAdvanceRun's own comment — so this must still run
    // even on a duplicate, or the conversation would wrongly get stuck
    // "open" with AI auto-reply re-enabled).
    expect(
      conversationUpdates.some((u) => u.status === "pending" && u.ai_autoreply_disabled === true),
    ).toBe(true);
    // Still auditable — just flagged, not silently dropped.
    expect(
      flowRunEventInserts.some(
        (e) => e.event_type === "handoff" && e.payload && (e.payload as { duplicate?: boolean }).duplicate === true,
      ),
    ).toBe(true);
  });

  it("with no all_selected_node_key configured, falls back to showing everything rather than sending nothing", async () => {
    const nodeNoRedirect: Partial<FlowNodeRow> = {
      ...TWO_OPTION_LIST_NODE,
      config: { ...(TWO_OPTION_LIST_NODE.config as object), all_selected_node_key: undefined },
    };
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_TOPICS],
      flowNodes: [nodeNoRedirect],
      priorRunCount: 1,
      contactState: { selected_options: { topics: ["catalog", "location"] } },
    });
    adminDbHolder.current = db;

    await dispatchInboundToFlows(reentryInput("menú"));

    expect(engineSendInteractiveList).toHaveBeenCalledWith(
      expect.objectContaining({
        sections: [
          {
            title: undefined,
            rows: [
              { id: "catalog", title: "Catálogo", description: undefined },
              { id: "location", title: "Ubicación", description: undefined },
            ],
          },
        ],
      }),
    );
  });
});

describe("collect_input — skips a question already answered in a prior run (flow_contact_state.known_vars)", () => {
  const FLOW_WITH_COLLECT_INPUT: Partial<FlowRow> = {
    id: "flow-manual",
    account_id: "acct-1",
    status: "active",
    trigger_type: "first_inbound_message",
    trigger_config: { reentry_keywords: ["menu", "menú"] },
    entry_node_id: "ask_ciudad",
  };
  const ASK_CIUDAD: Partial<FlowNodeRow> = {
    node_key: "ask_ciudad",
    node_type: "collect_input",
    config: { prompt_text: "¿Cuál es tu ciudad?", var_key: "ciudad", next_node_key: "end" },
  };
  const END_NODE_2: Partial<FlowNodeRow> = { node_key: "end", node_type: "end", config: {} };

  it("already known: skips straight to next_node_key, never sends the prompt", async () => {
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_COLLECT_INPUT],
      flowNodes: [ASK_CIUDAD, END_NODE_2],
      priorRunCount: 1,
      contactState: { known_vars: { ciudad: "Lima" } },
    });
    adminDbHolder.current = db;

    const result = await dispatchInboundToFlows(reentryInput("menú"));

    expect(mockSendText).not.toHaveBeenCalled();
    expect(result.outcome).toBe("completed");
  });

  it("not known yet: sends the prompt normally", async () => {
    const { db } = makeReentryOverrideFakeDb({
      conversationGate: { assigned_agent_id: null },
      flows: [FLOW_WITH_COLLECT_INPUT],
      flowNodes: [ASK_CIUDAD, END_NODE_2],
      priorRunCount: 0,
    });
    adminDbHolder.current = db;

    await dispatchInboundToFlows({ ...reentryInput("Hola"), isFirstInboundMessage: true });

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¿Cuál es tu ciudad?" }),
    );
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
  sendDocument: string | null;
}> = {}) {
  return {
    fields: {},
    replyText: "¿En qué ciudad?",
    done: false,
    handoff: false,
    sendDocument: null,
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

describe("shouldSendInactivityNudge", () => {
  const BASE = {
    ageMinutes: 65,
    nudgeAfterMinutes: 60,
    lastAdvancedAt: "2026-01-01T10:00:00Z",
    lastNudgeSentAt: null as string | null,
    optedOut: false,
  };

  it("true once ageMinutes reaches nudgeAfterMinutes, with no prior nudge", () => {
    expect(shouldSendInactivityNudge(BASE)).toBe(true);
  });

  it("false before the threshold", () => {
    expect(shouldSendInactivityNudge({ ...BASE, ageMinutes: 59 })).toBe(false);
  });

  it("optedOut short-circuits to false regardless of everything else", () => {
    expect(
      shouldSendInactivityNudge({ ...BASE, ageMinutes: 999, optedOut: true }),
    ).toBe(false);
  });

  it("false when a nudge was already sent for THIS silence period (nudge is after last_advanced_at)", () => {
    expect(
      shouldSendInactivityNudge({
        ...BASE,
        lastNudgeSentAt: "2026-01-01T10:30:00Z", // after lastAdvancedAt (10:00)
      }),
    ).toBe(false);
  });

  it("true again once last_advanced_at moves past the old nudge — a reply resets eligibility with no explicit reset write", () => {
    expect(
      shouldSendInactivityNudge({
        ...BASE,
        lastNudgeSentAt: "2026-01-01T09:00:00Z", // BEFORE lastAdvancedAt (10:00) — stale
        lastAdvancedAt: "2026-01-01T10:00:00Z",
        ageMinutes: 65, // 65 min since the NEW last_advanced_at
      }),
    ).toBe(true);
  });

  it("a nudge sent exactly at last_advanced_at does not count as covering this period (strict >)", () => {
    expect(
      shouldSendInactivityNudge({
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
    visionEnabled: false,
    documents: [],
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
function makeFakeDb(
  opts: {
    advanceSucceeds?: boolean;
    replyReceivedDuplicate?: boolean;
    replyReceivedError?: string;
    /** Makes `wasHandedOffRecently` resolve true — simulates a
     *  `flow_run_events` "handoff" row already logged for this
     *  conversation within the cooldown window. */
    recentHandoffExists?: boolean;
  } = {},
) {
  const advanceSucceeds = opts.advanceSucceeds ?? true;
  const updates: { table: string; payload: Record<string, unknown> }[] = [];
  const inserts: { table: string; payload: Record<string, unknown> }[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];

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
        const isReplyReceived =
          table === "flow_run_events" &&
          (payload as { event_type?: string }).event_type === "reply_received";
        if (isReplyReceived && opts.replyReceivedDuplicate) {
          return Promise.resolve({
            error: { message: "duplicate key value violates unique constraint (23505)" },
          });
        }
        if (isReplyReceived && opts.replyReceivedError) {
          return Promise.resolve({ error: { message: opts.replyReceivedError } });
        }
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
      gte() {
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
        } else if (
          table === "flow_run_events" &&
          mode === null &&
          selected &&
          opts.recentHandoffExists
        ) {
          resolve({ data: [{ id: "evt-recent-handoff" }], error: null });
        } else {
          resolve({ data: null, error: null });
        }
      },
    };
    return chain;
  }

  return {
    db: {
      from,
      rpc: (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      },
    } as never,
    updates,
    inserts,
    rpcCalls,
  };
}

const mockExtract = vi.mocked(extractWithReply);
const mockLoadAiConfig = vi.mocked(loadAiConfig);
const mockBuildContext = vi.mocked(buildConversationContext);
const mockSendText = vi.mocked(engineSendText);
const mockSendMedia = vi.mocked(engineSendMedia);
const mockTranscribe = vi.mocked(transcribeInboundAudio);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAiConfig.mockResolvedValue(aiConfig());
  mockBuildContext.mockResolvedValue([{ role: "user", content: "hola" }]);
  mockSendText.mockResolvedValue({ whatsapp_message_id: "wamid.test" } as never);
  mockSendMedia.mockResolvedValue({ whatsapp_message_id: "wamid.media" } as never);
});

describe("enterCollectAiNode", () => {
  it("with intro_text: sends it verbatim, never calls extractWithReply, and resets ai_turn_count", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 3 });
    const node = makeNode({ config: collectAiConfig({ intro_text: "¿Qué necesitas cotizar?" }) });

    const outcome = await enterCollectAiNode(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockExtract).not.toHaveBeenCalled();
    // Static, author-written text — must NOT carry the inbox's AI badge.
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¿Qué necesitas cotizar?", aiGenerated: false }),
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
    // Model-drafted question — must carry the inbox's AI badge.
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "¿Qué equipos, en qué ciudad, y qué rubro?",
        aiGenerated: true,
      }),
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
    // The closing line is the model's own text — must carry the AI badge.
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¡Listo, gracias!", aiGenerated: true }),
    );
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
    // Regression guard: a collect_ai handoff used to only set `status`,
    // never `ai_autoreply_disabled` — leaving dispatchInboundToAiReply
    // (which never checks `status`) free to keep auto-replying on a
    // thread the flow had already told the customer a human would
    // take over. Both must always be set together — see
    // markConversationPendingHandoff.
    expect(
      updates.some(
        (u) => u.table === "conversations" && u.payload.ai_autoreply_disabled === true,
      ),
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
      expect.objectContaining({ text: "Ok, te comunico con un asesor.", aiGenerated: true }),
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
    // Author-written fallback text, not the model — no AI badge.
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Un asesor te va a contactar en breve para ayudarte con tu cotización.",
        aiGenerated: false,
      }),
    );
  });

  it("a provider failure within the handoff cooldown skips the repeated handoff_fallback_text, but the conversation still ends up pending", async () => {
    const { db, updates } = makeFakeDb({ recentHandoffExists: true });
    const run = makeRun();
    const node = makeNode({
      config: collectAiConfig({
        handoff_fallback_text: "Un asesor te va a contactar en breve para ayudarte con tu cotización.",
      }),
    });
    mockExtract.mockRejectedValue(new Error("timeout"));

    const outcome = await handleCollectAiReply(db, run, node, new Map());

    expect(outcome).toEqual({ outcome: "handed_off" });
    expect(mockSendText).not.toHaveBeenCalled();
    // Still ends up pending/disabled — see executeHandoff's note on why
    // this write can't be skipped just because the message was.
    expect(
      updates.some((u) => u.table === "conversations" && u.payload.ai_autoreply_disabled === true),
    ).toBe(true);
  });

  it("a provider failure with handoff_node_key configured always sends its message, even within the handoff cooldown — it's advancing to a different node, not repeating a terminal handoff", async () => {
    const { db } = makeFakeDb({ recentHandoffExists: true });
    const run = makeRun();
    const node = makeNode({
      config: collectAiConfig({
        handoff_fallback_text: "Un asesor te va a contactar en breve.",
        handoff_node_key: "other_node",
      }),
    });
    mockExtract.mockRejectedValue(new Error("timeout"));

    await handleCollectAiReply(db, run, node, new Map([["other_node", makeNode({ node_key: "other_node", node_type: "end", config: {} })]]));

    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Un asesor te va a contactar en breve." }),
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
      expect.objectContaining({ text: "Un asesor te contactará pronto.", aiGenerated: false }),
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
      expect.objectContaining({
        text: "Puntual: te comunico con un asesor ya mismo.",
        aiGenerated: true,
      }),
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

  describe("document send (Opción B)", () => {
    const DOCUMENTS: CollectAiNodeConfig["documents"] = [
      {
        key: "catalogo",
        label: "Catálogo de productos",
        media_type: "document",
        media_url: "https://storage.example/catalogo.pdf",
        filename: "catalogo.pdf",
      },
    ];

    it("sends the matching document via engineSendMedia when the model sets send_document, alongside the normal reply_text", async () => {
      const { db } = makeFakeDb();
      const run = makeRun();
      const node = makeNode({ config: collectAiConfig({ documents: DOCUMENTS }) });
      mockExtract.mockResolvedValue(
        extractResult({ sendDocument: "catalogo", replyText: "¡Acá tienes! ¿En qué ciudad estás?" }),
      );

      await handleCollectAiReply(db, run, node, new Map());

      expect(mockSendMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "document",
          link: "https://storage.example/catalogo.pdf",
          filename: "catalogo.pdf",
        }),
      );
      // The document doesn't replace the conversational reply.
      expect(mockSendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "¡Acá tienes! ¿En qué ciudad estás?" }),
      );
    });

    it("never calls engineSendMedia when send_document is null", async () => {
      const { db } = makeFakeDb();
      const run = makeRun();
      const node = makeNode({ config: collectAiConfig({ documents: DOCUMENTS }) });
      mockExtract.mockResolvedValue(extractResult({ sendDocument: null }));

      await handleCollectAiReply(db, run, node, new Map());

      expect(mockSendMedia).not.toHaveBeenCalled();
    });

    it("skips the send (without throwing) when the key no longer matches any configured document", async () => {
      const { db } = makeFakeDb();
      const run = makeRun();
      // No `documents` configured at all on this node.
      const node = makeNode({ config: collectAiConfig() });
      mockExtract.mockResolvedValue(extractResult({ sendDocument: "catalogo" }));

      const outcome = await handleCollectAiReply(db, run, node, new Map());

      expect(mockSendMedia).not.toHaveBeenCalled();
      expect(outcome.outcome).toBe("advanced");
    });

    it("a failed document send is logged but the normal reply still goes out", async () => {
      const { db, inserts } = makeFakeDb();
      const run = makeRun();
      const node = makeNode({ config: collectAiConfig({ documents: DOCUMENTS }) });
      mockExtract.mockResolvedValue(
        extractResult({ sendDocument: "catalogo", replyText: "¿En qué ciudad estás?" }),
      );
      mockSendMedia.mockRejectedValue(new Error("Meta rejected the media"));

      await handleCollectAiReply(db, run, node, new Map());

      const errorEvent = inserts.find(
        (i) => i.table === "flow_run_events" && i.payload.event_type === "error",
      );
      expect(errorEvent?.payload.payload).toMatchObject({
        reason: "collect_ai_document_send_failed",
      });
      expect(mockSendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "¿En qué ciudad estás?" }),
      );
    });
  });

  describe("business-hours handoff closing text", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("outside business hours: sends handoff_fallback_text_after_hours, overriding even the model's own courtesy message", async () => {
      vi.setSystemTime(new Date("2024-01-07T15:00:00Z")); // Sunday — closed
      const { db } = makeFakeDb();
      const run = makeRun();
      const node = makeNode({
        config: collectAiConfig({
          handoff_fallback_text: "Un asesor te contactará pronto.",
          handoff_fallback_text_after_hours: "Estamos fuera de horario, te contactamos mañana.",
        }),
      });
      mockExtract.mockResolvedValue(
        extractResult({ handoff: true, replyText: "Ok, te comunico con un asesor." }),
      );

      await handleCollectAiReply(db, run, node, new Map());

      expect(mockSendText).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Estamos fuera de horario, te contactamos mañana.",
          aiGenerated: false,
        }),
      );
    });

    it("within business hours: unaffected — the model's courtesy message still wins as before", async () => {
      vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
      const { db } = makeFakeDb();
      const run = makeRun();
      const node = makeNode({
        config: collectAiConfig({
          handoff_fallback_text: "Un asesor te contactará pronto.",
          handoff_fallback_text_after_hours: "Estamos fuera de horario, te contactamos mañana.",
        }),
      });
      mockExtract.mockResolvedValue(
        extractResult({ handoff: true, replyText: "Ok, te comunico con un asesor." }),
      );

      await handleCollectAiReply(db, run, node, new Map());

      expect(mockSendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Ok, te comunico con un asesor.", aiGenerated: true }),
      );
    });

    it("no handoff_fallback_text_after_hours configured: behavior is unchanged regardless of the time", async () => {
      vi.setSystemTime(new Date("2024-01-07T15:00:00Z")); // Sunday — closed, but irrelevant here
      const { db } = makeFakeDb();
      const run = makeRun();
      const node = makeNode({
        config: collectAiConfig({ handoff_fallback_text: "Un asesor te contactará pronto." }),
      });
      mockExtract.mockRejectedValue(new Error("timeout")); // provider_error — no model message

      await handleCollectAiReply(db, run, node, new Map());

      expect(mockSendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Un asesor te contactará pronto.", aiGenerated: false }),
      );
    });
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
        aiGenerated: false,
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
      expect.objectContaining({
        text: "Por ahora no puedo ver fotos, ¿me lo contás en texto?",
        aiGenerated: false,
      }),
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

const AUDIO_REF = { mediaId: "media-1", mimeType: "audio/ogg", messageDbId: "msg-1" };

describe("handleCollectAiBlankReply", () => {
  it("with no audio: behaves exactly like handleCollectAiNonTextReply — never calls transcribeInboundAudio", async () => {
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });

    const outcome = await handleCollectAiBlankReply(db, run, node, new Map(), undefined);

    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
        aiGenerated: false,
      }),
    );
  });

  it("with audio but transcribe_audio_enabled off: falls back to the fixed non-text reply, never calls transcribeInboundAudio", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ transcribeAudioEnabled: false, embeddingsApiKey: "sk-embed" }));
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });

    await handleCollectAiBlankReply(db, run, node, new Map(), AUDIO_REF);

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
        aiGenerated: false,
      }),
    );
  });

  it("with audio but no embeddings key: same fallback, even with the switch on — treated as disabled, not an error", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: null }));
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });

    await handleCollectAiBlankReply(db, run, node, new Map(), AUDIO_REF);

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
        aiGenerated: false,
      }),
    );
  });

  it("on a usable transcript: calls transcribeInboundAudio with the account's embeddings key, then falls through to handleCollectAiReply (extractWithReply, ai_turn_count bumped) instead of the fixed reply", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: "sk-embed" }));
    mockTranscribe.mockResolvedValue("quiero cotizar dos cocinas");
    mockExtract.mockResolvedValue(extractResult({ replyText: "¿Y la ciudad?" }));
    const { db } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 0 });
    const node = makeNode({ config: collectAiConfig() });

    const outcome = await handleCollectAiBlankReply(db, run, node, new Map(), AUDIO_REF);

    expect(mockTranscribe).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: "acct-1",
        audio: AUDIO_REF,
        embeddingsApiKey: "sk-embed",
      }),
    );
    // Fell through to the normal turn — same as any text reply.
    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(run.ai_turn_count).toBe(1);
    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¿Y la ciudad?" }),
    );
  });

  it("an empty/failed transcription (transcribeInboundAudio returns null) falls back to the fixed non-text reply, without ever calling extractWithReply", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: "sk-embed" }));
    mockTranscribe.mockResolvedValue(null);
    const { db } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 0 });
    const node = makeNode({ config: collectAiConfig() });

    const outcome = await handleCollectAiBlankReply(db, run, node, new Map(), AUDIO_REF);

    expect(mockExtract).not.toHaveBeenCalled();
    expect(run.ai_turn_count).toBe(0);
    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
        aiGenerated: false,
      }),
    );
  });

  it("with an image but vision_enabled off: falls back to the fixed non-text reply, never calls extractWithReply", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: false }));
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });

    await handleCollectAiBlankReply(db, run, node, new Map(), undefined, true);

    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
        aiGenerated: false,
      }),
    );
  });

  it("with an image and vision_enabled on: falls through to handleCollectAiReply — extractWithReply runs, buildConversationContext gets includeImages:true, ai_turn_count bumped", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }));
    mockExtract.mockResolvedValue(extractResult({ replyText: "¿Y para cuándo lo necesitás?" }));
    const { db } = makeFakeDb();
    const run = makeRun({ ai_turn_count: 0 });
    const node = makeNode({ config: collectAiConfig() });

    const outcome = await handleCollectAiBlankReply(db, run, node, new Map(), undefined, true);

    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockBuildContext).toHaveBeenCalledWith(db, "conv-1", undefined, {
      includeImages: true,
    });
    expect(run.ai_turn_count).toBe(1);
    expect(outcome).toEqual({ outcome: "advanced" });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "¿Y para cuándo lo necesitás?" }),
    );
  });

  it("a video/sticker/document inbound (isImageMessage absent) never triggers the vision fallthrough, even with vision_enabled on", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }));
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });

    await handleCollectAiBlankReply(db, run, node, new Map(), undefined, undefined);

    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
        aiGenerated: false,
      }),
    );
  });
});

describe("runCollectAiTurn — includeImages wiring", () => {
  it("passes includeImages matching config.visionEnabled to buildConversationContext, for both text and image turns", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }));
    mockExtract.mockResolvedValue(extractResult({ replyText: "¿Algo más?" }));
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });

    await handleCollectAiReply(db, run, node, new Map());

    expect(mockBuildContext).toHaveBeenCalledWith(db, "conv-1", undefined, {
      includeImages: true,
    });
  });

  it("passes includeImages:false when vision_enabled is off, same as today's plain-text behavior", async () => {
    mockLoadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: false }));
    mockExtract.mockResolvedValue(extractResult({ replyText: "¿Algo más?" }));
    const { db } = makeFakeDb();
    const run = makeRun();
    const node = makeNode({ config: collectAiConfig() });

    await handleCollectAiReply(db, run, node, new Map());

    expect(mockBuildContext).toHaveBeenCalledWith(db, "conv-1", undefined, {
      includeImages: false,
    });
  });
});

describe("handleReplyForActiveRun — claimReplyReceived atomic duplicate guard", () => {
  it("a concurrent/duplicate delivery (unique_violation on the reply_received insert) stops immediately — no capture, no advance, no send", async () => {
    const { db, updates } = makeFakeDb({ replyReceivedDuplicate: true });
    const run = makeRun({ current_node_key: "topics" });
    const node = makeNode({
      node_key: "topics",
      node_type: "collect_input",
      config: { prompt_text: "¿Cuál es tu ciudad?", var_key: "ciudad", next_node_key: "end" },
    });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "Lima", meta_message_id: "wamid.dup" },
      new Map([["topics", node]]),
    );

    expect(result).toEqual({
      consumed: true,
      flow_run_id: run.id,
      outcome: "duplicate_inbound_ignored",
    });
    expect(mockSendText).not.toHaveBeenCalled();
    // Never even attempted to capture "Lima" into vars.ciudad.
    expect(updates.some((u) => u.table === "flow_runs" && "vars" in u.payload)).toBe(false);
  });

  it("a non-uniqueness insert error fails OPEN (treated as claimed) rather than silently dropping the reply", async () => {
    const { db } = makeFakeDb({ replyReceivedError: "connection reset" });
    const run = makeRun({ current_node_key: "topics" });
    const node = makeNode({
      node_key: "topics",
      node_type: "collect_input",
      config: { prompt_text: "¿Cuál es tu ciudad?", var_key: "ciudad", next_node_key: "end" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "Lima", meta_message_id: "wamid.infra-error" },
      new Map([["topics", node], ["end", makeNode({ node_key: "end", node_type: "end", config: {} })]]),
    );

    expect(result.outcome).not.toBe("duplicate_inbound_ignored");
    errorSpy.mockRestore();
  });
});

describe("handleReplyForActiveRun — collect_input validation", () => {
  const PHONE_NODE_CONFIG = {
    prompt_text: "No tenemos tu número — ¿nos lo compartes?",
    var_key: "telefono_contacto",
    validation: "phone" as const,
    next_node_key: "end",
  };

  it("an invalid phone reply is NOT captured — reprompts with the default validation message instead of the original prompt_text", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ current_node_key: "ask_phone", reprompt_count: 0 });
    const node = makeNode({
      node_key: "ask_phone",
      node_type: "collect_input",
      config: PHONE_NODE_CONFIG,
    });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "987", meta_message_id: "wamid.badphone" },
      new Map([["ask_phone", node]]),
    );

    expect(result.outcome).toBe("fallback_fired");
    expect(updates.some((u) => u.table === "flow_runs" && "vars" in u.payload)).toBe(false);
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Ese número no parece válido. ¿Podrías escribirlo nuevamente? Debe tener 9 dígitos, por ejemplo: 987654321.",
      }),
    );
  });

  it("a node-specific validation_error_text overrides the built-in default", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "ask_phone", reprompt_count: 0 });
    const node = makeNode({
      node_key: "ask_phone",
      node_type: "collect_input",
      config: {
        ...PHONE_NODE_CONFIG,
        validation_error_text: "Necesitamos un número de 9 dígitos para poder llamarte.",
      },
    });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "no tengo", meta_message_id: "wamid.badphone2" },
      new Map([["ask_phone", node]]),
    );

    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Necesitamos un número de 9 dígitos para poder llamarte.",
      }),
    );
  });

  it("a valid phone (with spaces as separators) IS captured and advances", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ current_node_key: "ask_phone", reprompt_count: 1 });
    const node = makeNode({
      node_key: "ask_phone",
      node_type: "collect_input",
      config: PHONE_NODE_CONFIG,
    });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "987 654 321", meta_message_id: "wamid.goodphone" },
      new Map([
        ["ask_phone", node],
        ["end", makeNode({ node_key: "end", node_type: "end", config: {} })],
      ]),
    );

    expect(result.outcome).not.toBe("fallback_fired");
    expect(
      updates.some(
        (u) =>
          u.table === "flow_runs" &&
          (u.payload.vars as Record<string, unknown> | undefined)?.telefono_contacto ===
            "987 654 321",
      ),
    ).toBe(true);
  });

  it("repeated invalid phone replies exhaust fallback_policy's max_reprompts and hand off, same as any other node", async () => {
    const { db } = makeFakeDb();
    // DEFAULT_FALLBACK_POLICY.max_reprompts is 2 — reprompt_count
    // already at 2 means this invalid reply is the 3rd, exhausting it.
    const run = makeRun({ current_node_key: "ask_phone", reprompt_count: 2 });
    const node = makeNode({
      node_key: "ask_phone",
      node_type: "collect_input",
      config: PHONE_NODE_CONFIG,
    });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "abc", meta_message_id: "wamid.badphone-exhaust" },
      new Map([["ask_phone", node]]),
    );

    expect(result.outcome).toBe("handed_off");
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Gracias, un asesor va a continuar tu consulta en breve." }),
    );
  });
});

describe("handleReplyForActiveRun — release_unmatched_text_to_assistant", () => {
  beforeEach(() => {
    vi.mocked(engineSendInteractiveList).mockResolvedValue({
      whatsapp_message_id: "wamid.list",
    } as never);
    vi.mocked(engineSendInteractiveButtons).mockResolvedValue({
      whatsapp_message_id: "wamid.buttons",
    } as never);
  });

  function topicsNode(configOverrides: Record<string, unknown> = {}): FlowNodeRow {
    return makeNode({
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: "¿En qué te ayudamos?",
        button_label: "Ver opciones",
        sections: [
          {
            title: "Menú",
            rows: [{ reply_id: "precios", title: "Precios", next_node_key: "precios_node" }],
          },
        ],
        unmatched_text_keywords: ["asesor", "humano"],
        handoff_node_key: "human_handoff",
        ...configOverrides,
      },
    });
  }

  it("a button tap still advances normally when the flag is on", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ release_unmatched_text_to_assistant: true });
    const nextNode = makeNode({ node_key: "precios_node", node_type: "end", config: {} });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "interactive_reply", reply_id: "precios", reply_title: "Precios", meta_message_id: "wamid.1" },
      new Map([["topics", node], ["precios_node", nextNode]]),
    );

    expect(result.consumed).toBe(true);
    expect(result.outcome).not.toBe("released_to_assistant");
  });

  it("an escalation keyword still wins over the release flag — 'asesor' still hands off, never released", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
    const { db, updates } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ release_unmatched_text_to_assistant: true });
    const handoffNode = makeNode({
      node_key: "human_handoff",
      node_type: "handoff",
      config: { note: "escalated" },
    });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "quiero hablar con un asesor", meta_message_id: "wamid.2" },
      new Map([["topics", node], ["human_handoff", handoffNode]]),
    );
    vi.useRealTimers();

    expect(result.consumed).toBe(true);
    expect(result.outcome).not.toBe("released_to_assistant");
    // Regression guard: executeHandoff (the `handoff` node type) used
    // to only set `status`, never `ai_autoreply_disabled` — see the
    // same fix on the collect_ai handoff path above.
    expect(
      updates.some((u) => u.table === "conversations" && u.payload.status === "pending"),
    ).toBe(true);
    expect(
      updates.some(
        (u) => u.table === "conversations" && u.payload.ai_autoreply_disabled === true,
      ),
    ).toBe(true);
    // Regression guard: executeHandoff used to send NOTHING to the
    // customer — silent handoff. Falls back to the fixed default text
    // since this node didn't configure customer_message.
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Gracias, un asesor va a continuar tu consulta en breve.",
      }),
    );
  });

  it("a handoff node's configured customer_message is sent instead of the default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ release_unmatched_text_to_assistant: true });
    const handoffNode = makeNode({
      node_key: "human_handoff",
      node_type: "handoff",
      config: { note: "escalated", customer_message: "Ya te derivo con un asesor, ¡gracias!" },
    });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "quiero hablar con un asesor", meta_message_id: "wamid.custom-msg" },
      new Map([["topics", node], ["human_handoff", handoffNode]]),
    );
    vi.useRealTimers();

    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Ya te derivo con un asesor, ¡gracias!" }),
    );
  });

  it("outside business hours, a handoff node falls back to the after-hours default even with no config for it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-07T15:00:00Z")); // Sunday — closed
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ release_unmatched_text_to_assistant: true });
    const handoffNode = makeNode({
      node_key: "human_handoff",
      node_type: "handoff",
      config: { customer_message: "Un asesor te va a contactar ahora mismo." },
    });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "quiero hablar con un asesor", meta_message_id: "wamid.after-hours" },
      new Map([["topics", node], ["human_handoff", handoffNode]]),
    );
    vi.useRealTimers();

    // customer_message is for business hours — after hours wins over it.
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Gracias por escribirnos. En este momento estamos fuera de nuestro horario de atención — un asesor se pondrá en contacto contigo apenas estemos disponibles nuevamente.",
      }),
    );
  });

  it("a handoff node's configured customer_message_after_hours wins outside business hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-07T15:00:00Z")); // Sunday — closed
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ release_unmatched_text_to_assistant: true });
    const handoffNode = makeNode({
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        customer_message: "Un asesor te va a contactar ahora mismo.",
        customer_message_after_hours: "Estamos fuera de horario — te escribimos mañana.",
      },
    });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "quiero hablar con un asesor", meta_message_id: "wamid.after-hours-2" },
      new Map([["topics", node], ["human_handoff", handoffNode]]),
    );
    vi.useRealTimers();

    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Estamos fuera de horario — te escribimos mañana." }),
    );
  });

  it("flag off: genuinely unmatched text falls through to the normal fallback_policy, unchanged", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics", reprompt_count: 0 });
    const node = topicsNode(); // no release flag

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "¿tendrían catálogo?", meta_message_id: "wamid.3" },
      new Map([["topics", node]]),
    );

    expect(result.consumed).toBe(true);
    expect(result.outcome).toBe("fallback_fired");
    expect(
      updates.some(
        (u) => u.table === "flow_runs" && u.payload.end_reason === "released_to_assistant",
      ),
    ).toBe(false);
  });

  it("outside business hours, the reprompt hint uses reprompt_hint_text_after_hours instead of the normal one — customer keeps navigating, no dead end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-07T15:00:00Z")); // Sunday — closed
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics", reprompt_count: 0 });
    const node = topicsNode({
      reprompt_hint_text: "No entendí tu mensaje — elegí una opción del menú.",
      reprompt_hint_text_after_hours:
        "Estamos fuera de horario, pero mientras tanto podés seguir navegando las opciones —x!",
    });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "precio de la cocina", meta_message_id: "wamid.after-hours-reprompt" },
      new Map([["topics", node]]),
    );
    vi.useRealTimers();

    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Estamos fuera de horario, pero mientras tanto podés seguir navegando las opciones —x!",
      }),
    );
  });

  it("within business hours, the normal reprompt_hint_text is used even when an after-hours variant is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics", reprompt_count: 0 });
    const node = topicsNode({
      reprompt_hint_text: "No entendí tu mensaje — elegí una opción del menú.",
      reprompt_hint_text_after_hours: "Estamos fuera de horario...",
    });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "precio de la cocina", meta_message_id: "wamid.in-hours-reprompt" },
      new Map([["topics", node]]),
    );
    vi.useRealTimers();

    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "No entendí tu mensaje — elegí una opción del menú." }),
    );
  });

  it("fallback_policy exhaustion (on_exhaust: 'handoff') sends a closing message before handing off — regression guard, this used to be silent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
    const { db, updates } = makeFakeDb();
    // DEFAULT_FALLBACK_POLICY (loadFlow resolves to null in this fake,
    // so resolveFallbackPolicy fills in the default: max_reprompts 2,
    // on_exhaust 'handoff') — reprompt_count already at 2 means this
    // unmatched reply is the 3rd, exhausting it.
    const run = makeRun({ current_node_key: "topics", reprompt_count: 2 });
    const node = topicsNode();

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "¿tendrían catálogo?", meta_message_id: "wamid.exhaust" },
      new Map([["topics", node]]),
    );
    vi.useRealTimers();

    expect(result.outcome).toBe("handed_off");
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Gracias, un asesor va a continuar tu consulta en breve.",
      }),
    );
    expect(
      updates.some((u) => u.table === "conversations" && u.payload.ai_autoreply_disabled === true),
    ).toBe(true);
  });

  it("fallback_policy exhaustion within the handoff cooldown skips the repeated closing message, but the conversation still ends up pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
    const { db, updates, inserts } = makeFakeDb({ recentHandoffExists: true });
    const run = makeRun({ current_node_key: "topics", reprompt_count: 2 });
    const node = topicsNode();

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "¿tendrían catálogo?", meta_message_id: "wamid.exhaust-dup" },
      new Map([["topics", node]]),
    );
    vi.useRealTimers();

    expect(result.outcome).toBe("handed_off");
    expect(engineSendText).not.toHaveBeenCalled();
    // Still ends up pending/disabled — see executeHandoff's note on why
    // this write can't be skipped just because the message was.
    expect(
      updates.some((u) => u.table === "conversations" && u.payload.ai_autoreply_disabled === true),
    ).toBe(true);
    expect(
      inserts.some(
        (i) =>
          i.table === "flow_run_events" &&
          i.payload.event_type === "handoff" &&
          (i.payload.payload as { duplicate?: boolean } | undefined)?.duplicate === true,
      ),
    ).toBe(true);
  });

  it("fallback_policy exhaustion outside business hours sends the after-hours default instead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-07T15:00:00Z")); // Sunday — closed
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics", reprompt_count: 2 });
    const node = topicsNode();

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "¿tendrían catálogo?", meta_message_id: "wamid.exhaust-after-hours" },
      new Map([["topics", node]]),
    );
    vi.useRealTimers();

    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Gracias por escribirnos. En este momento estamos fuera de nuestro horario de atención — un asesor se pondrá en contacto contigo apenas estemos disponibles nuevamente.",
      }),
    );
  });

  it("flag on: genuinely unmatched text ends the run and releases to the general assistant", async () => {
    const { db, updates } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ release_unmatched_text_to_assistant: true });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "¿tendrían catálogo?", meta_message_id: "wamid.4" },
      new Map([["topics", node]]),
    );

    expect(result).toEqual({
      consumed: false,
      flow_run_id: "run-1",
      outcome: "released_to_assistant",
    });
    const endUpdate = updates.find(
      (u) => u.table === "flow_runs" && u.payload.status === "completed",
    );
    expect(endUpdate?.payload).toMatchObject({
      status: "completed",
      end_reason: "released_to_assistant",
    });
  });
});

describe("handleReplyForActiveRun — text_routes", () => {
  beforeEach(() => {
    vi.mocked(engineSendInteractiveList).mockResolvedValue({
      whatsapp_message_id: "wamid.list",
    } as never);
  });

  function topicsNode(configOverrides: Record<string, unknown> = {}): FlowNodeRow {
    return makeNode({
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: "¿En qué te ayudamos?",
        button_label: "Ver opciones",
        sections: [
          {
            title: "Menú",
            rows: [{ reply_id: "precios", title: "Precios", next_node_key: "precios_node" }],
          },
        ],
        unmatched_text_keywords: ["asesor", "humano"],
        handoff_node_key: "human_handoff",
        text_routes: [
          { keywords: ["precio", "cotizar", "cotización", "cuanto cuesta"], node_key: "collect_inox_quote" },
        ],
        ...configOverrides,
      },
    });
  }

  it("routes free text naming a price/quote keyword straight to the configured node, bypassing fallback_policy entirely", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode();
    const quoteNode = makeNode({ node_key: "collect_inox_quote", node_type: "end", config: {} });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "hola, cuánto cuesta una cocina industrial?", meta_message_id: "wamid.route-1" },
      new Map([["topics", node], ["collect_inox_quote", quoteNode]]),
    );

    expect(result.consumed).toBe(true);
    expect(result.outcome).not.toBe("released_to_assistant");
    expect(result.outcome).not.toBe("fallback_fired");
  });

  it("matches even without accents ('cotizacion' vs configured 'cotización')", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode();
    const quoteNode = makeNode({ node_key: "collect_inox_quote", node_type: "end", config: {} });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "quiero una cotizacion", meta_message_id: "wamid.route-2" },
      new Map([["topics", node], ["collect_inox_quote", quoteNode]]),
    );

    expect(result.consumed).toBe(true);
    expect(result.outcome).not.toBe("released_to_assistant");
    expect(result.outcome).not.toBe("fallback_fired");
  });

  it("the escalation keyword ('asesor') still wins over a text_routes match when both are present in the message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode();
    const handoffNode = makeNode({ node_key: "human_handoff", node_type: "handoff", config: {} });
    const quoteNode = makeNode({ node_key: "collect_inox_quote", node_type: "end", config: {} });

    const result = await handleReplyForActiveRun(
      db,
      run,
      {
        kind: "text",
        text: "quiero hablar con un asesor sobre el precio",
        meta_message_id: "wamid.route-3",
      },
      new Map([["topics", node], ["human_handoff", handoffNode], ["collect_inox_quote", quoteNode]]),
    );
    vi.useRealTimers();

    expect(result.outcome).toBe("handed_off");
  });

  it("a route match wins over release_unmatched_text_to_assistant", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ release_unmatched_text_to_assistant: true });
    const quoteNode = makeNode({ node_key: "collect_inox_quote", node_type: "end", config: {} });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "precio porfa", meta_message_id: "wamid.route-4" },
      new Map([["topics", node], ["collect_inox_quote", quoteNode]]),
    );

    expect(result.outcome).not.toBe("released_to_assistant");
  });

  it("text that matches no route and no escalation keyword still falls through to fallback_policy", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode();

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "¿tienen delivery a Arequipa?", meta_message_id: "wamid.route-5" },
      new Map([["topics", node]]),
    );

    expect(result.outcome).toBe("fallback_fired");
  });

  it("an empty text_routes array behaves exactly like it's unset", async () => {
    const { db } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({ text_routes: [] });

    const result = await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "precio porfa", meta_message_id: "wamid.route-6" },
      new Map([["topics", node]]),
    );

    expect(result.outcome).toBe("fallback_fired");
  });

  it("also_marks_selected records the equivalent reply_id — typing 'catálogo' excludes the row exactly like tapping it would", async () => {
    const { db, rpcCalls } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode({
      text_routes: [
        {
          keywords: ["catalogo", "catálogo"],
          node_key: "answer_catalog",
          also_marks_selected: "catalog",
        },
      ],
    });
    const catalogNode = makeNode({ node_key: "answer_catalog", node_type: "end", config: {} });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "me pasas el catálogo?", meta_message_id: "wamid.route-7" },
      new Map([["topics", node], ["answer_catalog", catalogNode]]),
    );

    expect(
      rpcCalls.some(
        (c) =>
          c.name === "record_flow_option_selected" &&
          (c.args as { p_node_key: string; p_reply_id: string }).p_node_key === "topics" &&
          (c.args as { p_node_key: string; p_reply_id: string }).p_reply_id === "catalog",
      ),
    ).toBe(true);
  });

  it("a route with no also_marks_selected records nothing", async () => {
    const { db, rpcCalls } = makeFakeDb();
    const run = makeRun({ current_node_key: "topics" });
    const node = topicsNode();
    const quoteNode = makeNode({ node_key: "collect_inox_quote", node_type: "end", config: {} });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "precio porfa", meta_message_id: "wamid.route-8" },
      new Map([["topics", node], ["collect_inox_quote", quoteNode]]),
    );

    expect(rpcCalls.some((c) => c.name === "record_flow_option_selected")).toBe(false);
  });

  it("a text_route to a handoff node with a captured var interpolates it into the agent-facing summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T13:30:00Z")); // Monday 8:30am Peru — open
    const { db, updates } = makeFakeDb();
    const run = makeRun({
      current_node_key: "topics",
      vars: { visita_dia: "sábado", visita_hora: "10am" },
    });
    const node = topicsNode({
      text_routes: [{ keywords: ["visita"], node_key: "human_handoff" }],
    });
    const handoffNode = makeNode({
      node_key: "human_handoff",
      node_type: "handoff",
      config: { note: "Quiere agendar visita para {{vars.visita_dia}} a las {{vars.visita_hora}}" },
    });

    await handleReplyForActiveRun(
      db,
      run,
      { kind: "text", text: "quiero agendar una visita", meta_message_id: "wamid.route-9" },
      new Map([["topics", node], ["human_handoff", handoffNode]]),
    );
    vi.useRealTimers();

    expect(
      updates.some(
        (u) =>
          u.table === "conversations" &&
          typeof u.payload.ai_handoff_summary === "string" &&
          u.payload.ai_handoff_summary.includes("sábado") &&
          u.payload.ai_handoff_summary.includes("10am"),
      ),
    ).toBe(true);
  });
});

