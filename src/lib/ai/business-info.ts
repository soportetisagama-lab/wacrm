import type { SupabaseClient } from '@supabase/supabase-js'
import { hasPrice } from './learning/guards'
import { mentionsCatalog } from '@/lib/catalog-request'

// ============================================================
// Business info for the AI, taken from the account's own WhatsApp
// menus. A customer who types "¿dónde queda su tienda?" instead of
// tapping the "Ubicación y horario" option gets the free-text AI, which
// never saw that answer — so it said "no tengo la dirección". This
// collects, from every ACTIVE flow, "option title: text it sends"
// (option of a buttons/list node → send_message node) and hands it to
// the model as reference data. Never prices: any text with an amount,
// currency or price word is left out (house rule, same guard the
// learning pipeline uses).
// ============================================================

/** Cap for the whole block, in characters. */
export const BUSINESS_INFO_MAX_CHARS = 3000
/** Cap for one answer, in characters. */
const ENTRY_MAX_CHARS = 700
/** How many chained send_message nodes to follow after an option. */
const MAX_CHAIN = 3
/** Per-account cache: the context is built on every inbound message. */
const CACHE_TTL_MS = 5 * 60 * 1000

export interface MenuAnswer {
  title: string
  text: string
}

interface NodeLike {
  node_key: string
  node_type: string
  config: unknown
}

interface OptionLike {
  title?: unknown
  next_node_key?: unknown
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Drop {{vars.X}} placeholders and collapse whitespace to one line. */
function cleanText(text: string): string {
  return text
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

/** Clock times ("9:00", "18.30", "6:00 pm") read as figures to the price
 *  guard ("de 9:00 a 18:00" → "a 18" looks like an amount), so they're
 *  neutralized before checking. Currency, "soles", "precio"… still trip. */
const CLOCK_TIME_RE = /\b\d{1,2}[:.]\d{2}\b/g
/** Same for small ranges that are clearly time: "en 24 a 48 horas",
 *  "domingos de 10 a 13" (after a weekday). Never with a currency. */
const NO_MONEY_AFTER = String.raw`(?!\s*(?:soles|sol|lucas|d[oó]lares|usd|pen|mil|%))`
const TIME_RANGE_RE = new RegExp(
  String.raw`\b\d{1,2}\s*(?:a|-|y)\s*\d{1,2}(?=\s*(?:horas?|hrs?|h|d[ií]as|am|pm|a\.\s?m|p\.\s?m)(?![a-záéíóúñ]))` +
    '|' +
    String.raw`(\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|feriados?)\b[^.\n\d]{0,30}?\bde\s+)\d{1,2}\s+a\s+\d{1,2}\b` +
    NO_MONEY_AFTER,
  'gi',
)

/** True when a menu text mentions money in any way. */
export function menuTextHasPrice(text: string): boolean {
  return hasPrice(
    text.replace(CLOCK_TIME_RE, ' hora ').replace(TIME_RANGE_RE, (_m, lead?: string) => `${lead ?? ''} hora `),
  )
}

function menuOptions(node: NodeLike): OptionLike[] {
  const cfg = (node.config ?? {}) as {
    buttons?: unknown
    sections?: unknown
  }
  if (node.node_type === 'send_buttons' && Array.isArray(cfg.buttons)) {
    return cfg.buttons as OptionLike[]
  }
  if (node.node_type === 'send_list' && Array.isArray(cfg.sections)) {
    return (cfg.sections as { rows?: unknown }[]).flatMap((s) =>
      Array.isArray(s?.rows) ? (s.rows as OptionLike[]) : [],
    )
  }
  return []
}

/**
 * From one flow's nodes: every menu option that leads to a
 * send_message node becomes `{ title, text }`. Follows a short chain of
 * send_message nodes (a message split in two). Pure; no filtering of
 * prices here — see `buildBusinessInfoBlock`.
 */
export function extractMenuAnswers(nodes: NodeLike[]): MenuAnswer[] {
  const byKey = new Map<string, NodeLike>()
  for (const n of nodes) if (n?.node_key) byKey.set(n.node_key, n)

  const out: MenuAnswer[] = []
  for (const node of nodes) {
    for (const opt of menuOptions(node)) {
      const title = cleanText(str(opt?.title))
      let key = str(opt?.next_node_key)
      const texts: string[] = []
      const seen = new Set<string>()
      while (key && !seen.has(key) && texts.length < MAX_CHAIN) {
        seen.add(key)
        const target = byKey.get(key)
        if (!target || target.node_type !== 'send_message') break
        const cfg = (target.config ?? {}) as { text?: unknown; next_node_key?: unknown }
        const text = cleanText(str(cfg.text))
        if (text) texts.push(text)
        key = str(cfg.next_node_key)
      }
      if (title && texts.length > 0) out.push({ title, text: texts.join(' ') })
    }
  }
  return out
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Render the block for the system prompt: drops answers that mention
 * prices, dedupes (same text under several options → titles merged),
 * caps each answer and the whole block. Null when nothing is left.
 */
export function buildBusinessInfoBlock(
  answers: MenuAnswer[],
  maxChars: number = BUSINESS_INFO_MAX_CHARS,
): string | null {
  const merged = new Map<string, { titles: string[]; text: string }>()
  for (const a of answers) {
    if (!a.title || !a.text) continue
    if (menuTextHasPrice(a.title) || menuTextHasPrice(a.text)) continue
    // Maxi: el catálogo lo envía un asesor; la IA nunca ve respuestas de menú sobre él.
    if (mentionsCatalog(a.title) || mentionsCatalog(a.text)) continue
    const key = norm(a.text)
    if (!key) continue
    const prev = merged.get(key)
    if (prev) {
      if (!prev.titles.some((t) => norm(t) === norm(a.title))) prev.titles.push(a.title)
      continue
    }
    merged.set(key, { titles: [a.title], text: a.text })
  }

  const lines: string[] = []
  let used = 0
  for (const a of merged.values()) {
    const text = a.text.length > ENTRY_MAX_CHARS ? `${a.text.slice(0, ENTRY_MAX_CHARS - 1).trimEnd()}…` : a.text
    const line = `- ${a.titles.join(' / ')}: ${text}`
    if (used + line.length + 1 > maxChars) continue
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 0 ? lines.join('\n') : null
}

const cache = new Map<string, { at: number; value: string | null }>()

/** Test hook. */
export function resetBusinessInfoCache(): void {
  cache.clear()
}

/**
 * Load the block for an account from its ACTIVE flows. Cached per
 * account for a few minutes. Best-effort: any error returns null (and
 * isn't cached) so the reply goes on without it.
 */
export async function loadBusinessInfo(
  db: SupabaseClient,
  accountId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const hit = cache.get(accountId)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value

  try {
    const { data: flows, error: flowsErr } = await db
      .from('flows')
      .select('id')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
    if (flowsErr) throw flowsErr
    const ids = ((flows ?? []) as { id: string }[]).map((f) => f.id)

    let value: string | null = null
    if (ids.length > 0) {
      const { data: nodes, error: nodesErr } = await db
        .from('flow_nodes')
        .select('flow_id, node_key, node_type, config')
        .in('flow_id', ids)
      if (nodesErr) throw nodesErr
      const rows = (nodes ?? []) as (NodeLike & { flow_id: string })[]
      // node_key is unique per flow only — extract flow by flow.
      const answers = ids.flatMap((id) => extractMenuAnswers(rows.filter((r) => r.flow_id === id)))
      value = buildBusinessInfoBlock(answers)
    }
    cache.set(accountId, { at: now, value })
    return value
  } catch (err) {
    console.error(
      '[ai business-info] could not load menu answers:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
