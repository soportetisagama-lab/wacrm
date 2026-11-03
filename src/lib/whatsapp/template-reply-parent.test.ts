import { describe, it, expect } from "vitest";
import { normalizeLabel, pickTemplateByButton } from "./template-reply-parent";

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
