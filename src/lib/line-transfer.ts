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

/** First word of the contact's WhatsApp name, for the template greeting ({{1}} can't be empty). */
export function greetingName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, "");
  return first || "estimado cliente";
}
