import { describe, expect, it } from "vitest";
import { matchMenuTextChoice, withNumberedOptions } from "./menu-text";

const rows = [
  { reply_id: "quote", title: "📋 Cotizar productos", next_node_key: "n1" },
  { reply_id: "loc", title: "📍 Ubicación y horarios", next_node_key: "n2" },
  { reply_id: "adv", title: "Hablar con un asesor", next_node_key: "n3" },
];

describe("withNumberedOptions", () => {
  it("lists the options under the body", () => {
    const out = withNumberedOptions("Elige una opción", rows);
    expect(out).toContain("1. 📋 Cotizar productos");
    expect(out).toContain("3. Hablar con un asesor");
  });
  it("leaves the body alone when it would not fit", () => {
    const body = "x".repeat(1000);
    expect(withNumberedOptions(body, rows)).toBe(body);
  });
});

describe("matchMenuTextChoice", () => {
  it("matches by number", () => {
    expect(matchMenuTextChoice("2", rows)?.reply_id).toBe("loc");
    expect(matchMenuTextChoice("3.", rows)?.reply_id).toBe("adv");
  });
  it("matches by name, ignoring emoji and accents", () => {
    expect(matchMenuTextChoice("ubicacion y horarios", rows)?.reply_id).toBe("loc");
  });
  it("ignores numbers out of range, phone numbers and free text", () => {
    expect(matchMenuTextChoice("9", rows)).toBeNull();
    expect(matchMenuTextChoice("972701776", rows)).toBeNull();
    expect(matchMenuTextChoice("quiero cotizar góndolas", rows)).toBeNull();
  });
});
