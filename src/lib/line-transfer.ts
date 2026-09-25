/**
 * Cross-line transfer ("Derivar a otra línea") — server-only config.
 *
 * Each Sagama line is its own wacrm deployment with its own WhatsApp
 * number. A conversation can't move between numbers, so a transfer
 * asks the TARGET line (through its public API, /api/v1) to open the
 * conversation itself with an approved template.
 *
 * Configured per deployment with one env var, e.g. on Retail:
 *
 *   LINE_TRANSFER_CONFIG={"from":"Sagama Retail","targets":[{"id":"inox",
 *     "label":"Sagama Inox","url":"https://xlr9-xlr9.ewrx7u.easypanel.host",
 *     "apiKey":"wacrm_live_…","template":"derivacion_linea","language":"es"}]}
 *
 * The target's API key needs the `contacts:write` and `messages:send`
 * scopes. Its template takes two body variables: {{1}} the customer's
 * first name, {{2}} what they asked about. Unset/invalid config → the
 * feature is simply hidden.
 */

export interface LineTransferTarget {
  id: string;
  label: string;
  url: string;
  apiKey: string;
  template: string;
  language: string;
}

export interface LineTransferConfig {
  /** How this line names itself to the target (tag on the contact there). */
  from: string;
  targets: LineTransferTarget[];
}

export function getLineTransferConfig(): LineTransferConfig | null {
  const raw = process.env.LINE_TRANSFER_CONFIG;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LineTransferConfig>;
    const targets = (parsed.targets ?? []).filter(
      (t): t is LineTransferTarget =>
        !!t && [t.id, t.label, t.url, t.apiKey, t.template, t.language].every(
          (v) => typeof v === "string" && v.length > 0,
        ),
    );
    if (!parsed.from || targets.length === 0) return null;
    return { from: parsed.from, targets };
  } catch {
    console.error("[line-transfer] LINE_TRANSFER_CONFIG is not valid JSON");
    return null;
  }
}

export interface TranscriptMessage {
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  created_at: string;
}

const SENDER_LABEL: Record<string, string> = { customer: "Cliente", agent: "Asesor", bot: "Bot" };
const MEDIA_LABEL: Record<string, string> = {
  image: "📷 Foto",
  video: "🎥 Video",
  audio: "🎤 Audio",
  document: "📄 Documento",
  location: "📍 Ubicación",
};
const MAX_LINE = 500;

/** "25/09 16:04" in Peru time — fixed UTC-5, no DST (see flows/business-hours.ts). */
function limaTimestamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The note the receiving line gets on the contact: who handed it over,
 * the topic, and the source chat's recent messages (oldest first) so
 * the new advisor doesn't have to ask again. Media shows as a label +
 * its link, since the files live in the source line's storage.
 */
export function buildTransferNote(args: {
  from: string;
  topic: string;
  agentName: string | null;
  messages: TranscriptMessage[];
}): string {
  const header = `🔀 Derivado desde ${args.from}${args.agentName ? ` por ${args.agentName}` : ""} — tema: ${args.topic}`;
  if (args.messages.length === 0) return header;
  const lines = args.messages.map((m) => {
    const when = limaTimestamp(m.created_at);
    const who = SENDER_LABEL[m.sender_type] ?? m.sender_type;
    const media = MEDIA_LABEL[m.content_type];
    let text = m.content_text?.trim() ?? "";
    if (media) text = [media, text, m.media_url].filter(Boolean).join(" ");
    if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)}…`;
    return `[${when}] ${who}: ${text || "(sin texto)"}`;
  });
  return `${header}\n\nHistorial del chat en ${args.from}:\n${lines.join("\n")}`;
}

/** First word of the contact's WhatsApp name, for the template greeting ({{1}} can't be empty). */
export function greetingName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, "");
  return first || "estimado cliente";
}
