import { textOf, type ChatMessage } from './types'
import { stripContextAnnotations } from './annotations'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 * An image-only turn (no caption) yields '' — no retrieval, not a crash.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return textOf(messages[i].content)
  }
  return messages.length > 0 ? textOf(messages[messages.length - 1].content) : ''
}

/**
 * Knowledge-base query for the auto-reply bot: the last `count` customer
 * turns, oldest first, without transcript annotations. A follow-up like
 * "¿y en acero?" only makes sense together with the message before it.
 * Falls back to `latestUserMessage` when there's no customer turn.
 */
export function recentUserMessages(messages: ChatMessage[], count = 3): string {
  const picked: string[] = []
  for (let i = messages.length - 1; i >= 0 && picked.length < count; i--) {
    if (messages[i].role !== 'user') continue
    const text = stripContextAnnotations(textOf(messages[i].content)).trim()
    if (text) picked.unshift(text)
  }
  return picked.length > 0 ? picked.join('\n') : stripContextAnnotations(latestUserMessage(messages))
}
