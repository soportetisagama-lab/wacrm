import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregate, gradesToScores, readableReply, runExam, shuffledOrder } from './exam'
import { resetLearningAvailability } from './openai-judge'
import type { AiConfig } from '../types'
import type { EvalCase } from './eval-set'

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

const CONFIG: AiConfig = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  apiKey: 'sk-exam',
  systemPrompt: 'Vendemos equipos.',
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 10,
  handoffAgentId: null,
  embeddingsApiKey: null,
  transcribeAudioEnabled: false,
  visionEnabled: false,
  documents: [],
}

// retrieveKnowledge swallows DB errors and returns [].
const DB = {
  from: () => {
    throw new Error('no db in tests')
  },
} as unknown as SupabaseClient

const cases = (n: number): EvalCase[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, question: `pregunta ${i}`, expected: 'pide medidas', must_not: null }))

beforeEach(() => resetLearningAvailability())
afterEach(() => vi.unstubAllGlobals())

describe('pure helpers', () => {
  it('shuffledOrder is a permutation', () => {
    expect(shuffledOrder(3, () => 0).sort()).toEqual([0, 1, 2])
    expect(shuffledOrder(1)).toEqual([0])
  })

  it('readableReply shows control markers in plain words', () => {
    expect(readableReply('[[HANDOFF]]')).toBe('[deriva a un asesor]')
    expect(readableReply('Aquí va [[SEND_DOCUMENT:catalogo]]')).toBe('Aquí va [envía un documento]')
  })

  it('gradesToScores maps the shown order back and zeroes price leaks', () => {
    // variant 1 shown first, variant 0 second
    const order = [1, 0]
    const grades = { grades: [{ answer: 1, score: 0.9 }, { answer: 2, score: 0.4 }] }
    expect(gradesToScores(grades, order, [false, false])).toEqual([0.4, 0.9])
    expect(gradesToScores(grades, order, [false, true])).toEqual([0.4, 0])
    expect(gradesToScores({ grades: [{ answer: 7, score: 1 }] }, [0], [false])).toEqual([0])
  })

  it('aggregate gives 0-100 and pass counts', () => {
    expect(
      aggregate(
        [
          { caseId: 'a', scores: [1, 0.5], priceLeak: [false, false] },
          { caseId: 'b', scores: [0.5, 0.75], priceLeak: [false, false] },
        ],
        2,
      ),
    ).toEqual({ scores: [75, 62.5], passed: [1, 1] })
  })
})

describe('runExam', () => {
  it('answers blind, scores every variant and flags price leaks', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      if (body.response_format) {
        // Judge: give 1 to every answer it sees.
        const n = (body.messages[1].content.match(/Respuesta \d+:/g) ?? []).length
        return ok({ choices: [{ message: { content: JSON.stringify({ grades: Array.from({ length: n }, (_, i) => ({ answer: i + 1, score: 1 })) }) } }] })
      }
      const isCandidate = body.messages[0].content.includes('Lessons learned')
      return ok({ choices: [{ message: { content: isCandidate ? 'Sale S/ 300' : '¿Qué medidas necesitas?' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runExam({ db: DB, accountId: 'acc', config: CONFIG, openai: { apiKey: 'sk-exam', model: 'gpt-5.4-mini' } }, cases(3), [
      { label: 'base', model: 'gpt-5.4-mini', rules: [] },
      { label: 'cand', model: 'gpt-5.4-mini', rules: ['Pregunta primero las medidas.'] },
    ])
    expect(result.scores).toEqual([100, 0])
    expect(result.total).toBe(3)
    expect(result.reliable).toBe(false)
  })

  it('skips a case that fails instead of scoring it 0', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: { body: string }) => {
        calls += 1
        const body = JSON.parse(init.body)
        if (calls === 1) return ok({ choices: [{ message: { content: '' } }] })
        if (body.response_format) return ok({ choices: [{ message: { content: '{"grades":[{"answer":1,"score":0.8}]}' } }] })
        return ok({ choices: [{ message: { content: 'hola' } }] })
      }),
    )
    const result = await runExam({ db: DB, accountId: 'acc', config: CONFIG, openai: { apiKey: 'sk-exam2', model: 'm' } }, cases(2), [
      { label: 'base', model: 'm', rules: [] },
    ])
    expect(result.total).toBe(1)
    expect(result.scores).toEqual([80])
  })
})

describe('learned rules in the prompt', () => {
  it('go before the no-prices rule, which stays last, capped at 20', async () => {
    const { buildSystemPrompt, NO_PRICES_GUIDANCE } = await import('../defaults')
    const { buildExtractionPrompt } = await import('../schema')
    const rules = Array.from({ length: 25 }, (_, i) => `Regla número ${i}`)
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', learnedRules: rules })
    expect(p).toContain('- Regla número 19')
    expect(p).not.toContain('- Regla número 20')
    expect(p.endsWith(NO_PRICES_GUIDANCE)).toBe(true)
    const e = buildExtractionPrompt({ fields: [], knownValues: {}, learnedRules: ['Saluda breve'] })
    expect(e).toContain('- Saluda breve')
    expect(e.endsWith(NO_PRICES_GUIDANCE)).toBe(true)
  })
})
