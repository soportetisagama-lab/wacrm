import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeLabel, pickTemplateByButton, resolveReplyParent } from "./template-reply-parent";

type Result = { data: unknown; error: { message: string } | null };

/** Minimal chainable Supabase fake: one canned result per table read. */
function fakeDb(reads: Record<string, Result>) {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const read = reads[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        limit: () => builder,
        maybeSingle: () => {
          throw new Error("maybeSingle must not be used");
        },
        then: (ok: (r: Result) => unknown) => Promise.resolve(read).then(ok),
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "new-row" }, error: null }),
            }),
          };
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, inserts };
}

const baseArgs = {
  accountId: "acc",
  conversationId: "conv",
  contextId: "wamid.X",
  button: { text: "Sí", payload: "Sí" },
  inboundAt: "2026-11-03T15:50:00.000Z",
};

describe("resolveReplyParent", () => {
  it("stores the rebuilt template as 'bot' (never 'agent')", async () => {
    const { db, inserts } = fakeDb({
      message_templates: {
        data: [{ name: "gondolas", body_text: "Hola", buttons: [{ type: "QUICK_REPLY", text: "Sí" }] }],
        error: null,
      },
    });
    const r = await resolveReplyParent(db, baseArgs);
    expect(r).toEqual({ id: "new-row", templateName: "gondolas" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sender_type).toBe("bot");
    expect(inserts[0].content_type).toBe("template");
  });

  it("reuses an existing row (even if duplicates exist) without inserting", async () => {
    const { db, inserts } = fakeDb({
      messages: {
        data: [
          { id: "m1", template_name: "gondolas" },
          { id: "m2", template_name: "gondolas" },
        ],
        error: null,
      },
    });
    const r = await resolveReplyParent(db, baseArgs);
    expect(r).toEqual({ id: "m1", templateName: "gondolas" });
    expect(inserts).toHaveLength(0);
  });

  it("returns null and inserts nothing when the lookup errors", async () => {
    const { db, inserts } = fakeDb({
      messages: { data: null, error: { message: "boom" } },
      message_templates: {
        data: [{ name: "gondolas", body_text: "Hola", buttons: [{ type: "QUICK_REPLY", text: "Sí" }] }],
        error: null,
      },
    });
    expect(await resolveReplyParent(db, baseArgs)).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("returns null and inserts nothing when the broadcast lookup errors", async () => {
    const { db, inserts } = fakeDb({
      broadcast_recipients: { data: null, error: { message: "boom" } },
    });
    expect(await resolveReplyParent(db, baseArgs)).toBeNull();
    expect(inserts).toHaveLength(0);
  });
});

const tpl = (name: string, quick: string[]) => ({
  name,
  body_text: "Hola",
  buttons: [
    ...quick.map((text) => ({ type: "QUICK_REPLY" as const, text })),
    { type: "URL" as const, text: "Ver casos de éxito", url: "https://example.com" },
  ],
});

describe("normalizeLabel", () => {
  it("ignores case, accents and spaces", () => {
    expect(normalizeLabel(" SÍ ")).toBe("si");
  });
});

describe("pickTemplateByButton", () => {
  it("returns the only template with that quick reply", () => {
    const r = pickTemplateByButton([tpl("a", ["Sí"]), tpl("b", ["Me interesa"])], "Sí");
    expect(r?.name).toBe("a");
  });

  it("returns null when ambiguous or unknown", () => {
    expect(pickTemplateByButton([tpl("a", ["Sí"]), tpl("b", ["si"])], "Sí")).toBeNull();
    expect(pickTemplateByButton([tpl("a", ["No"])], "Sí")).toBeNull();
  });

  it("ignores URL buttons", () => {
    expect(pickTemplateByButton([tpl("a", [])], "Ver casos de éxito")).toBeNull();
  });
});
