import { describe, expect, it } from 'vitest'
import { decideNight, matchExamples, projectRules, ROLLBACK_TOLERANCE } from './nightly'
import { compareCommonCases } from './exam'
import { isReady, learnablePairs, supportOf, withSupport } from './proposals'
import { cosine, greedyGroups, jaccard } from './similarity'
import { safeRules } from './rules'
import { exampleContent, isApplicable, type Proposal } from './apply'
import type { ReplyPair } from './pairs'

describe('auto-approval condition', () => {
  it('needs judge ≥ 0.7 and (2+ advisors or judge ≥ 0.9)', () => {
    expect(isReady(0.75, 2)).toBe(true)
    expect(isReady(0.75, 1)).toBe(false)
    expect(isReady(0.92, 1)).toBe(true)
    expect(isReady(0.65, 5)).toBe(false)
  })

  it('keeps support across nights in the reason prefix', () => {
    expect(supportOf(withSupport(3, 'Clara y útil'))).toBe(3)
    expect(supportOf('sin prefijo')).toBe(0)
    expect(supportOf(null)).toBe(0)
  })
})

describe('decideNight', () => {
  const same = { today: 80, previous: 80, common: 22 }
  const base = { base: 80, candidate: 82, reliable: true, ready: 2, regression: same }
  it('applies when the candidate does not lower the score', () => {
    expect(decideNight(base)).toEqual({ rollback: false, apply: true })
    expect(decideNight({ ...base, candidate: 80 }).apply).toBe(true)
  })
  it('discards when the candidate scores lower', () => {
    expect(decideNight({ ...base, candidate: 79.5 })).toMatchObject({ apply: false, rollback: false })
  })
  it('rolls back when the same cases score worse than last night', () => {
    const worse = { ...same, today: 80 - ROLLBACK_TOLERANCE - 0.1 }
    expect(decideNight({ ...base, regression: worse })).toMatchObject({ rollback: true, apply: false })
    expect(decideNight({ ...base, regression: { ...same, today: 80 - ROLLBACK_TOLERANCE } }).rollback).toBe(false)
  })
  it('never rolls back on an unreliable exam or too few common cases', () => {
    const worse = { ...same, today: 50 }
    expect(decideNight({ ...base, reliable: false, regression: worse }).rollback).toBe(false)
    expect(decideNight({ ...base, regression: { ...worse, common: 19 } }).rollback).toBe(false)
  })
  it('approves nothing with fewer than 20 cases', () => {
    expect(decideNight({ ...base, reliable: false })).toMatchObject({ apply: false })
  })
  it('nothing to do without ready items', () => {
    expect(decideNight({ ...base, ready: 0 })).toEqual({ rollback: false, apply: false })
  })
  it('first night (no previous exam) can still apply', () => {
    expect(decideNight({ ...base, regression: null }).apply).toBe(true)
  })
})

describe('compareCommonCases', () => {
  it('compares only the cases both nights share', () => {
    const tonight = [
      { caseId: 'a', scores: [0.5], priceLeak: [false] },
      { caseId: 'b', scores: [1], priceLeak: [false] },
      { caseId: 'new', scores: [0], priceLeak: [false] },
    ]
    const prev = new Map([
      ['a', 1],
      ['b', 1],
      ['gone', 0],
    ])
    expect(compareCommonCases(tonight, 0, prev)).toEqual({ today: 75, previous: 100, common: 2 })
    expect(compareCommonCases(tonight, 0, new Map())).toEqual({ today: null, previous: null, common: 0 })
  })
})

describe('projectRules', () => {
  it('examines exactly the rules that stay after the cap', () => {
    const active = Array.from({ length: 20 }, (_, i) => `activa ${i}`) // newest first
    const out = projectRules(active, ['nueva A', 'nueva B'])
    expect(out).toHaveLength(20)
    expect(out.slice(0, 2)).toEqual(['nueva B', 'nueva A'])
    expect(out).not.toContain('activa 18')
    expect(out).not.toContain('activa 19')
    expect(projectRules(['x'], ['y'])).toEqual(['y', 'x'])
  })
})

const ex = (question: string): Proposal => ({
  kind: 'example',
  candidateId: question,
  title: question,
  content: exampleContent(question, 'respuesta'),
  question,
  score: 0.9,
  support: 2,
  ready: true,
})

describe('matching candidate examples to exam cases', () => {
  it('picks the closest by word overlap', () => {
    const out = matchExamples('¿tienen campanas extractoras para cocina?', [
      ex('¿venden campanas extractoras?'),
      ex('¿hacen envíos a provincia?'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('campanas extractoras')
  })
})

describe('similarity', () => {
  it('cosine and jaccard', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(jaccard('mesa de acero', 'mesa acero inoxidable')).toBeGreaterThan(0.4)
  })
  it('greedyGroups joins similar items to the first matching seed', () => {
    const v = [[1, 0], [0.99, 0.1], [0, 1]]
    expect(greedyGroups(3, (i, j) => cosine(v[i], v[j]), 0.9)).toEqual([[0, 1], [2]])
  })
})

describe('advisor pairs', () => {
  const p = (over: Partial<ReplyPair>): ReplyPair => ({
    conversationId: 'c',
    messageId: 'm1',
    replier: 'agent',
    replierId: 'u1',
    customerText: '¿hacen mesas a medida?',
    context: [],
    replyText: 'Sí, las hacemos a medida. ¿Qué medidas necesitas?',
    followUp: null,
    at: '2026-10-20T10:00:00Z',
    ...over,
  })
  it('only advisor replies, long enough, not already decided', () => {
    expect(learnablePairs([p({}), p({ messageId: 'm2', replier: 'bot' }), p({ messageId: 'm3', replyText: 'ok' })], new Set())).toHaveLength(1)
    expect(learnablePairs([p({})], new Set(['m1']))).toHaveLength(0)
  })
})

describe('final safety', () => {
  it('rules with prices or personal data never reach the prompt', () => {
    expect(safeRules(['Pregunta las medidas primero.', 'Ofrece S/ 50 de descuento', 'Llama al 987654321', 3])).toEqual([
      'Pregunta las medidas primero.',
    ])
  })
  it('isApplicable re-checks guards on title and content', () => {
    expect(isApplicable({ title: 'Regla', content: 'Saluda breve y pregunta qué necesita.' })).toBe(true)
    expect(isApplicable({ title: 'Regla', content: 'Si duda, te lo dejo en 900' })).toBe(false)
  })
})
