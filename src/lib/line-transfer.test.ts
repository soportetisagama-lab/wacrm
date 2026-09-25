import { afterEach, describe, expect, it } from "vitest";
import { buildTransferNote, getLineTransferConfig, transferNoticeText } from "./line-transfer";

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

describe("buildTransferNote", () => {
  const base = { from: "Sagama Retail", topic: "cocinas inox", agentName: "Jimmy" };

  it("is just the header when there's no history", () => {
    expect(buildTransferNote({ ...base, messages: [] })).toBe(
      "🔀 Derivado desde Sagama Retail por Jimmy — tema: cocinas inox",
    );
  });

  it("lists messages oldest first with sender, Lima time, and media links", () => {
    const note = buildTransferNote({
      ...base,
      messages: [
        { sender_type: "customer", content_type: "text", content_text: "Hola", media_url: null, created_at: "2026-09-25T21:04:00Z" },
        { sender_type: "customer", content_type: "image", content_text: "mi cocina", media_url: "https://x/y.jpg", created_at: "2026-09-25T21:05:00Z" },
        { sender_type: "bot", content_type: "text", content_text: null, media_url: null, created_at: "2026-09-25T21:06:00Z" },
      ],
    });
    const lines = note.split("\n");
    expect(lines[2]).toBe("Historial del chat en Sagama Retail:");
    expect(lines[3]).toMatch(/^\[25\/09.*16:04.*\] Cliente: Hola$/);
    expect(lines[4]).toMatch(/Cliente: 📷 Foto mi cocina https:\/\/x\/y\.jpg$/);
    expect(lines[5]).toMatch(/Bot: \(sin texto\)$/);
  });
});

describe("transferNoticeText", () => {
  it("is formal and never uses the WhatsApp profile name", () => {
    expect(transferNoticeText({ topic: "cocinas inox", targetLabel: "Sagama Inox" })).toBe(
      "Estimado(a) cliente, gracias por su consulta sobre *cocinas inox*. Para brindarle una atención especializada, su caso será atendido por nuestra línea *Sagama Inox*, que ya le escribió desde su número oficial de WhatsApp. Quedamos a su disposición por este medio ante cualquier otra consulta.",
    );
  });
});
