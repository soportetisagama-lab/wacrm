import type { AutomationTriggerType } from '@/types'

/** Trigger types with a translated label under
 *  `Automations.builder.triggers.<type>.label`. */
export const KNOWN_TRIGGERS: readonly AutomationTriggerType[] = [
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'time_based',
  'interactive_reply',
  'template_button_reply',
]

export function isKnownTrigger(t: string): t is AutomationTriggerType {
  return (KNOWN_TRIGGERS as readonly string[]).includes(t)
}

/**
 * Chip classes for the trigger pill on the list row. Theme tokens only
 * (primary / muted / border) so every line keeps its own brand color.
 */
export const TRIGGER_PILL_CLASS =
  'border-primary/25 bg-primary/10 text-primary'

/**
 * Localized relative time ("hace 5 minutos", "5 minutes ago"…).
 * Returns null when there is no valid date so the caller can show its
 * own "never" text.
 */
export function formatRelative(
  iso: string | null | undefined,
  locale: string = 'es',
): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const diffSec = Math.round((then - Date.now()) / 1000)
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (abs < 60) return rtf.format(0, 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 86400), 'day')
  return new Date(iso).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
