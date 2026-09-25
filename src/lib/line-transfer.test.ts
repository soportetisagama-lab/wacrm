import { afterEach, describe, expect, it } from "vitest";
import { getLineTransferConfig, greetingName } from "./line-transfer";

const target = {
  id: "inox",
  label: "Sagama Inox",
  url: "https://inox.example",
  apiKey: "wacrm_live_x",
  template: "derivacion_linea",
  language: "es",
};

describe("getLineTransferConfig", () => {
  afterEach(() => {
    delete process.env.LINE_TRANSFER_CONFIG;
  });

  it("is null when unset", () => {
    expect(getLineTransferConfig()).toBeNull();
  });

  it("is null on invalid JSON", () => {
    process.env.LINE_TRANSFER_CONFIG = "{nope";
    expect(getLineTransferConfig()).toBeNull();
  });

  it("drops incomplete targets and keeps valid ones", () => {
    process.env.LINE_TRANSFER_CONFIG = JSON.stringify({
      from: "Sagama Retail",
      targets: [target, { ...target, id: "x", apiKey: "" }],
    });
    expect(getLineTransferConfig()).toEqual({ from: "Sagama Retail", targets: [target] });
  });

  it("is null when no target is valid", () => {
    process.env.LINE_TRANSFER_CONFIG = JSON.stringify({ from: "Sagama Retail", targets: [{ id: "x" }] });
    expect(getLineTransferConfig()).toBeNull();
  });
});

describe("greetingName", () => {
  it("uses the first word of the name", () => {
    expect(greetingName("Marisol Quispe")).toBe("Marisol");
  });

  it("strips emoji and symbols", () => {
    expect(greetingName("NAYARA👧🏻 EIRLYS")).toBe("NAYARA");
  });

  it("falls back when nothing usable is left", () => {
    expect(greetingName("💗")).toBe("estimado cliente");
    expect(greetingName(null)).toBe("estimado cliente");
  });
});
