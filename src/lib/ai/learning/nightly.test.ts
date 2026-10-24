import { describe, expect, it } from 'vitest'
import { extractPairs, type PairMessage, type ReplyPair } from './pairs'
import { isHardPair, sanitizeCases } from './eval-set'
import { cleanRule, pickBotPairs } from './self-review'
import { isNightDue } from './nightly'
import { limaDateKey, limaHour, previousDateKey } from './time'
import { trimSummary } from './report'

let seq = 0
function msg(sender: PairMessage['sender_type'], text: string, minute: number, senderId: string | null = null): PairMessage {
  seq += 1
  return {
    id: `m${seq}`,
    conversation_id: 'c1',
    sender_type: sender,
    sender_id: senderId,
    content_text: text,
    created_at: new Date(Date.UTC(2026, 9, 20, 10, minute)).toISOString(),
  }
}

describe('extractPairs', () => {
  it('pairs customer runs with the following advisor or bot run', () => {
    const pairs = extractPairs([
      msg('bot', 'Hola, ¿en qué te ayudo?', 0),
      msg('customer', 'Quiero una mesa', 1),
      msg('customer', 'de acero', 2),
      msg('agent', 'Claro, ¿qué medidas necesitas?', 3, 'u1'),
      msg('customer', '120 x 60', 4),
      msg('bot', 'Perfecto', 5),
      msg('customer', 'gracias', 6),
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[0]).toMatchObject({
      replier: 'agent',
      replierId: 'u1',
      customerText: 'Quiero una mesa de acero',
      replyText: 'Claro, ¿qué medidas necesitas?',
      followUp: '120 x 60',
    })
    expect(pairs[0].context).toEqual(['Bot: Hola, ¿en qué te ayudo?'])
    expect(pairs[1]).toMatchObject({ replier: 'bot', replierId: null, followUp: 'gracias' })
  })

  it('ignores a trailing customer run with no reply', () => {
    expect(extractPairs([msg('customer', 'hola', 0)])).toEqual([])
  })
})

const pair = (over: Partial<ReplyPair>): ReplyPair => ({
  conversationId: 'c',
  messageId: 'm',
  replier: 'bot',
  replierId: null,
  customerText: 'necesito una campana extractora',
  context: [],
  replyText: 'ok',
  followUp: null,
  at: '2026-10-20T10:00:00Z',
  ...over,
})

describe('exam set', () => {
  it('hard pairs: advisor replies, or the customer pushed back on the bot', () => {
    expect(isHardPair(pair({ replier: 'agent' }))).toBe(true)
    expect(isHardPair(pair({ followUp: 'no me entiendes' }))).toBe(true)
    expect(isHardPair(pair({ followUp: 'gracias' }))).toBe(false)
    expect(isHardPair(pair({ replier: 'agent', customerText: 'ok' }))).toBe(false)
  })

  it('keeps only usable cases without personal data or figures', () => {
    const out = sanitizeCases({
      cases: [
        { index: 0, usable: true, question: '¿Hacen mesas de acero a medida?', expected: 'Pregunta medidas y uso; no da precios', must_not: null },
        { index: 1, usable: true, question: '¿Cuánto cuesta?', expected: 'Dice que cuesta S/ 300', must_not: null },
        { index: 2, usable: true, question: 'Llámame al 987654321', expected: 'Pide datos', must_not: null },
        { index: 3, usable: false, question: 'hola', expected: 'saluda', must_not: null },
      ],
    })
    expect(out).toEqual([
      { question: '¿Hacen mesas de acero a medida?', expected: 'Pregunta medidas y uso; no da precios', must_not: null },
    ])
    expect(sanitizeCases(null)).toEqual([])
  })
})

describe('self-review', () => {
  it('cleans rules and rejects prices / personal data', () => {
    expect(cleanRule(' Pregunta primero las medidas antes de recomendar un modelo. ')).toEqual({
      ok: true,
      rule: 'Pregunta primero las medidas antes de recomendar un modelo.',
    })
    expect(cleanRule('Ofrece 10% de descuento si duda')).toEqual({ ok: false, reasons: ['price'] })
    expect(cleanRule('corto')).toEqual({ ok: false, reasons: 'empty' })
  })

  it('reviews pushed-back replies first', () => {
    const a = pair({ messageId: 'a', followUp: 'gracias' })
    const b = pair({ messageId: 'b', followUp: 'no, eso no pregunté' })
    const c = pair({ messageId: 'c', replier: 'agent' })
    expect(pickBotPairs([a, b, c]).map((p) => p.messageId)).toEqual(['b', 'a'])
  })
})

describe('schedule', () => {
  it('Lima is UTC-5', () => {
    const at = new Date('2026-10-24T07:59:00Z') // 02:59 Lima
    expect(limaHour(at)).toBe(2)
    expect(limaDateKey(at)).toBe('2026-10-24')
    expect(limaDateKey(new Date('2026-10-24T03:00:00Z'))).toBe('2026-10-23')
    expect(previousDateKey('2026-11-01')).toBe('2026-10-31')
  })

  it('night is due from 03:00 Lima, once per date', () => {
    expect(isNightDue(new Date('2026-10-24T07:59:00Z'), null)).toBe(false)
    expect(isNightDue(new Date('2026-10-24T08:00:00Z'), null)).toBe(true)
    expect(isNightDue(new Date('2026-10-24T08:00:00Z'), '2026-10-24')).toBe(false)
    expect(isNightDue(new Date('2026-10-25T08:30:00Z'), '2026-10-24')).toBe(true)
  })
})

describe('report', () => {
  it('caps list sizes', () => {
    const s = trimSummary({ learned: Array.from({ length: 50 }, (_, i) => `x${i}`), discarded: [{ text: 'a'.repeat(500), reason: 'r' }] })
    expect(s.learned).toHaveLength(30)
    expect(s.discarded?.[0].text).toHaveLength(160)
  })
})
