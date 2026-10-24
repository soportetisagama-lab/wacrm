// ============================================================
// WhatsApp interactive menus (reply buttons / lists) on Instagram and
// Messenger.
//
// Neither network has WhatsApp's list message. What both do have are
// quick replies: up to 13 tappable chips, each with a title of at most
// 20 characters, that send back the `payload` we set (we use the option
// id, so the Flows engine routes the tap exactly as on WhatsApp).
//
// When the options don't fit (too many, or a title too long to cut
// without losing meaning) the menu goes out as numbered text instead,
// and the reply ("2", or the option's own title) is mapped back to the
// option id by `matchNumberedReply`.
// ============================================================

import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'

export const QUICK_REPLY_MAX = 13
export const QUICK_REPLY_TITLE_MAX = 20

export interface MenuOption {
  id: string
  title: string
  description?: string
}

export interface QuickReply {
  content_type: 'text'
  title: string
  payload: string
}

export type SocialMenu =
  | { mode: 'quick_replies'; text: string; quickReplies: QuickReply[] }
  | { mode: 'numbered'; text: string }

/** Every option in a payload, in display order. */
export function menuOptions(payload: InteractiveMessagePayload): MenuOption[] {
  if (payload.kind === 'buttons') {
    return payload.buttons.map((b) => ({ id: b.id, title: b.title }))
  }
  return payload.sections.flatMap((s) =>
    s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })),
  )
}

function joinParts(parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join('\n\n')
}

/**
 * Build what to send for an interactive payload on a social channel.
 * Quick replies when every option fits as-is; otherwise numbered text.
 * Row descriptions only survive in the numbered form, so a list whose
 * rows carry descriptions is always sent numbered.
 */
export function toSocialMenu(payload: InteractiveMessagePayload): SocialMenu {
  const options = menuOptions(payload)
  const fitsQuickReplies =
    options.length > 0 &&
    options.length <= QUICK_REPLY_MAX &&
    options.every(
      (o) => o.title.trim().length > 0 && o.title.length <= QUICK_REPLY_TITLE_MAX && !o.description,
    )

  if (fitsQuickReplies) {
    return {
      mode: 'quick_replies',
      text: joinParts([payload.header, payload.body, payload.footer]),
      quickReplies: options.map((o) => ({
        content_type: 'text',
        title: o.title,
        payload: o.id,
      })),
    }
  }

  const lines = options.map((o, i) =>
    o.description ? `${i + 1}. ${o.title} — ${o.description}` : `${i + 1}. ${o.title}`,
  )
  return {
    mode: 'numbered',
    text: joinParts([
      payload.header,
      payload.body,
      lines.join('\n'),
      'Responde con el número de la opción que prefieras.',
      payload.footer,
    ]),
  }
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Map a typed reply back to one of the menu's options: the option number
 * ("2", "2.", "opción 2") or its exact title (accents/emoji/case
 * ignored). Returns null when it's free text — the caller then treats it
 * as an ordinary message.
 */
export function matchNumberedReply(
  text: string,
  payload: InteractiveMessagePayload,
): MenuOption | null {
  const options = menuOptions(payload)
  if (options.length === 0) return null
  const raw = text.trim()
  if (!raw) return null

  const numberMatch = raw.match(/^(?:opci[oó]n\s*)?#?\s*(\d{1,2})\s*[.)]?$/i)
  if (numberMatch) {
    const n = Number(numberMatch[1])
    return n >= 1 && n <= options.length ? options[n - 1] : null
  }

  const wanted = normalize(raw)
  if (!wanted) return null
  return options.find((o) => normalize(o.title) === wanted) ?? null
}
