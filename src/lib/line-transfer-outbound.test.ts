import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/flows/meta-send", () => ({ engineSendText: vi.fn() }));

import { isAcknowledgement } from "./line-transfer-outbound";

describe("isAcknowledgement", () => {
  it.each([
    "ok gracias",
    "Ok, gracias!!",
    "Muchas gracias 🙏",
    "gracias",
    "listo",
    "perfecto, muchas gracias",
    "ya",
    "👍",
    "🙏🏻🙏🏻",
    "Gracias, muy amable",
    "ok, hasta luego",
  ])("treats %j as an acknowledgement", (text) => {
    expect(isAcknowledgement(text)).toBe(true);
  });

  it.each([
    "también quiero cosas de esta línea",
    "quiero góndolas",
    "¿cuánto cuesta?",
    "ok pero necesito una cotización",
    "mi número es 987654321",
    "",
  ])("does not treat %j as an acknowledgement", (text) => {
    expect(isAcknowledgement(text)).toBe(false);
  });

  it("treats any sticker as an acknowledgement", () => {
    expect(isAcknowledgement("", true)).toBe(true);
  });
});
