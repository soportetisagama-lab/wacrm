// ------------------------------------------------------------
// Annotations added to the transcript so the model knows what it can't
// infer from the bare text: who on the business side wrote (a human
// advisor vs. the bot), what files the business already sent, what a
// menu offered, and when there was a long pause. All in brackets at
// the start of the turn; the system prompt tells the model they're
// system notes, and `stripContextAnnotations` removes any it echoes.
// ------------------------------------------------------------

export const ADVISOR_TAG = '[Asesor]'
export const LOCATION_TAG = '[Ubicación compartida]'
/** A pause this long between two messages gets a date/time stamp. */
export const LONG_GAP_MS = 3 * 60 * 60 * 1000

const LIMA_PARTS = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** "[lun 12/10 15:30]" in Peru time. */
export function formatContextTimestamp(date: Date): string {
  const parts = Object.fromEntries(LIMA_PARTS.formatToParts(date).map((p) => [p.type, p.value]))
  const weekday = (parts.weekday ?? '').replace(/\./g, '')
  return `[${weekday} ${parts.day}/${parts.month} ${parts.hour}:${parts.minute}]`
}

const ANNOTATION_RE =
  /^(?:\s*\[(?:Asesor|Se envió:[^\]]*|Ubicación compartida|[a-záéíóúñ]{2,4} \d{2}\/\d{2} \d{2}:\d{2})\])+\s*/i

/** Remove transcript annotations the model may have copied into its reply. */
export function stripContextAnnotations(text: string): string {
  return text.replace(ANNOTATION_RE, '')
}

const LIMA_LONG = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** "jueves, 23 de octubre de 2026, 15:30" — the current Peru time for prompts. */
export function formatPeruDateTime(date: Date): string {
  return LIMA_LONG.format(date)
}
