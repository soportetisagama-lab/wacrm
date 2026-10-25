/**
 * Text fallback for a `send_list` menu. WhatsApp shows a list as a
 * "Ver opciones" button some customers never notice, so the options are
 * also written under the message, numbered, and a typed number or option
 * name counts as a tap.
 */

/** Meta's limit for an interactive message body. */
const META_BODY_MAX = 1024

export interface MenuRow {
  reply_id: string
  title: string
  next_node_key: string
}

/** Lowercase, accent-free, letters and digits only ("📋 Cotizar" → "cotizar"). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The menu body with its options numbered underneath; unchanged when it would not fit. */
export function withNumberedOptions(body: string, rows: MenuRow[]): string {
  if (rows.length === 0) return body
  const lines = rows.map((r, i) => `${i + 1}. ${r.title}`)
  const extra = `\n\nTambién puedes escribir el número o el nombre de la opción:\n${lines.join('\n')}`
  return body.length + extra.length <= META_BODY_MAX ? body + extra : body
}

/** The row the customer chose by typing its number or its exact name, else null. */
export function matchMenuTextChoice(text: string, rows: MenuRow[]): MenuRow | null {
  const raw = text.trim()
  if (!raw || rows.length === 0) return null
  if (/^\d{1,2}[.)]?$/.test(raw)) {
    return rows[parseInt(raw, 10) - 1] ?? null
  }
  const wanted = normalize(raw)
  if (!wanted) return null
  return rows.find((r) => normalize(r.title) === wanted) ?? null
}
