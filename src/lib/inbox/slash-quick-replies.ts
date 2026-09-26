import type { QuickReply } from '@/types'

// "/" shortcut in the inbox composer: typing "/sal" right at the caret
// lists quick replies whose name matches, and picking one replaces the
// "/sal" token with the reply's text.

export interface SlashToken {
  /** Index of the "/" in the composer text. */
  start: number
  /** Index just past the token (the caret). */
  end: number
  /** What was typed after the "/". */
  query: string
}

/** The "/…" token ending at the caret, if any. The "/" must start the
 *  text or follow whitespace, so URLs ("https://…") and dates ("26/09")
 *  never trigger it. */
export function findSlashToken(text: string, caret: number): SlashToken | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)\/([^\s/]*)$/.exec(before)
  if (!m) return null
  const query = m[2]
  return { start: caret - query.length - 1, end: caret, query }
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Replies matching the typed name — names starting with it first,
 *  then names containing it, then replies whose text contains it. */
export function matchSlashQuickReplies(
  items: QuickReply[],
  query: string,
  limit = 8,
): QuickReply[] {
  const q = fold(query.trim())
  if (!q) return items.slice(0, limit)
  const starts: QuickReply[] = []
  const inTitle: QuickReply[] = []
  const inText: QuickReply[] = []
  for (const qr of items) {
    const title = fold(qr.title)
    if (title.startsWith(q)) starts.push(qr)
    else if (title.includes(q)) inTitle.push(qr)
    else if (fold(qr.content_text ?? '').includes(q)) inText.push(qr)
  }
  return [...starts, ...inTitle, ...inText].slice(0, limit)
}

/** Composer text with the token swapped for `insert`, and where the
 *  caret should land afterwards. */
export function replaceSlashToken(
  text: string,
  token: SlashToken,
  insert: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, token.start) + insert + text.slice(token.end),
    caret: token.start + insert.length,
  }
}
