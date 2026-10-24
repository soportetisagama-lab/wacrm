import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { fakeDb, fakeId } from './fake-db.testutil'
import { runNightForAccount } from './nightly'
import { resetLearningAvailability } from './openai-judge'
import { resetAiAvailability, isAiKeyPaused } from '../availability'

// End-to-end night on an in-memory DB with OpenAI mocked: learning from
// two advisors is applied when the exam doesn't drop, and a night whose
// exam is worse than the previous one rolls back the last 24 h.

const ACC = 'acc-1'
const NOW = new Date('2026-10-24T08:30:00Z') // 03:30 Lima

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  const at = (min: number) => new Date(NOW.getTime() - 3 * 60 * 60_000 + min * 60_000).toISOString()
  const cases = Array.from({ length: 22 }, (_, i) => ({
    id: fakeId(),
    account_id: ACC,
    question: `¿Hacen mesas de acero a medida? caso ${i}`,
    expected: 'Pregunta medidas',
    must_not: null,
    active: true,
    created_at: at(i),
  }))
  const convs = [
    { id: 'conv-1', account_id: ACC, last_message_at: at(50) },
    { id: 'conv-2', account_id: ACC, last_message_at: at(60) },
  ]
  const messages = [
    { id: fakeId(), conversation_id: 'conv-1', sender_type: 'customer', sender_id: null, content_text: '¿Hacen mesas de acero a medida?', created_at: at(10) },
    { id: fakeId(), conversation_id: 'conv-1', sender_type: 'agent', sender_id: 'adv-1', content_text: 'Sí, las fabricamos a medida. ¿Qué medidas necesitas?', created_at: at(11) },
    { id: fakeId(), conversation_id: 'conv-2', sender_type: 'customer', sender_id: null, content_text: '¿Fabrican mesas de acero a medida?', created_at: at(20) },
    { id: fakeId(), conversation_id: 'conv-2', sender_type: 'agent', sender_id: 'adv-2', content_text: 'Claro, las hacemos a medida. ¿Para qué uso sería?', created_at: at(21) },
  ]
  return fakeDb({
    ai_configs: [
      {
        account_id: ACC,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        api_key: encrypt('sk-night'),
        system_prompt: 'Vendemos equipos de acero.',
        is_active: true,
        auto_reply_enabled: true,
        auto_reply_max_per_conversation: 10,
        handoff_agent_id: null,
        embeddings_api_key: null,
        transcribe_audio_enabled: false,
        vision_enabled: false,
        documents: [],
      },
    ],
    ai_eval_cases: cases,
    conversations: convs,
    messages,
    ...extra,
  })
}

/** OpenAI mock: same embedding for everything, judge verdicts, and a
 *  fixed exam grade. */
function mockOpenAi(examScore: number) {
  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    if (url.includes('/embeddings')) {
      return ok({ data: (body.input as string[]).map((_, i) => ({ index: i, embedding: [1, 0, 0] })) })
    }
    const system: string = body.messages[0].content
    if (body.response_format?.json_schema?.name === 'advisor_examples') {
      return ok({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdicts: [
                  { index: 0, score: 0.8, generalizable: true, question: '¿Hacen mesas de acero a medida?', answer: 'Sí, las fabricamos a medida. ¿Qué medidas necesitas?', reason: 'Clara' },
                ],
              }),
            },
          },
        ],
      })
    }
    if (body.response_format?.json_schema?.name === 'exam_grades') {
      const n = (body.messages[1].content.match(/Respuesta \d+:/g) ?? []).length
      return ok({ choices: [{ message: { content: JSON.stringify({ grades: Array.from({ length: n }, (_, i) => ({ answer: i + 1, score: examScore })) }) } }] })
    }
    if (body.response_format) {
      // Any other structured call (exam set, self-review): nothing to add.
      return ok({ choices: [{ message: { content: JSON.stringify({ cases: [], reviews: [], verdicts: [] }) } }] })
    }
    void system
    return ok({ choices: [{ message: { content: '¿Qué medidas necesitas?' } }] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetLearningAvailability()
  resetAiAvailability()
})
afterEach(() => vi.unstubAllGlobals())

describe('nightly run', () => {
  it('learns from 2 advisors, passes the exam and applies it automatically', async () => {
    const { db, tables } = seed()
    mockOpenAi(0.9)
    expect(await runNightForAccount(db, ACC, NOW)).toBe('done')

    const learned = (tables.ai_knowledge_documents ?? []).filter((d) => d.source === 'advisor_learning')
    expect(learned).toHaveLength(1)
    expect(learned[0].status).toBe('active')
    expect((tables.ai_knowledge_chunks ?? []).filter((c) => c.document_id === learned[0].id)).not.toHaveLength(0)
    expect(String(learned[0].content)).not.toMatch(/S\/|\d{3,}/)

    const cand = tables.ai_learning_candidates.find((c) => c.source === 'advisor')
    expect(cand).toMatchObject({ verdict: 'accepted', knowledge_document_id: learned[0].id })
    expect(String(cand?.reason)).toMatch(/^Respaldo: 2\./)

    const report = tables.ai_daily_reports[0]
    expect(report).toMatchObject({ report_date: '2026-10-24', learned_count: 1, rolled_back: false, eval_before: 90, eval_after: 90 })
    expect(tables.ai_eval_runs.map((r) => r.phase).sort()).toEqual(['after', 'baseline', 'before'])
    expect(isAiKeyPaused('sk-night')).toBe(false)

    // Same night again: the lock stops a second run.
    expect(await runNightForAccount(db, ACC, NOW)).toBe('skipped')
  })

  it('rolls back what was learned in the last 24 h when the exam drops', async () => {
    const recentDoc = { id: 'doc-recent', account_id: ACC, source: 'self_review', status: 'active', title: 'Regla: x', content: 'Pregunta primero las medidas.', created_at: new Date(NOW.getTime() - 60 * 60_000).toISOString() }
    const oldDoc = { id: 'doc-old', account_id: ACC, source: 'advisor_learning', status: 'active', title: 'Aprendido: y', content: 'ejemplo', created_at: new Date(NOW.getTime() - 3 * 24 * 60 * 60_000).toISOString() }
    const { db, tables } = seed({
      ai_knowledge_documents: [recentDoc, oldDoc],
      ai_knowledge_chunks: [{ id: 'ch-old', document_id: 'doc-old', account_id: ACC, content: 'ejemplo', active: true }],
      ai_eval_runs: [{ id: 'prev', account_id: ACC, phase: 'after', score: 90, created_at: new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString() }],
      ai_learning_candidates: [{ id: 'cand-recent', account_id: ACC, source: 'self_review', verdict: 'accepted', knowledge_document_id: 'doc-recent', created_at: new Date(NOW.getTime() - 25 * 60 * 60_000).toISOString() }],
    })
    mockOpenAi(0.5)
    expect(await runNightForAccount(db, ACC, NOW)).toBe('done')

    const byId = Object.fromEntries(tables.ai_knowledge_documents.map((d) => [d.id, d]))
    expect(byId['doc-recent'].status).toBe('rolled_back')
    expect(byId['doc-old'].status).toBe('active')
    expect(tables.ai_learning_candidates.find((c) => c.id === 'cand-recent')?.verdict).toBe('rolled_back')
    // Nothing new is applied on a rollback night.
    expect(tables.ai_knowledge_documents.filter((d) => d.status === 'active' && d.source === 'advisor_learning')).toHaveLength(1)
    expect(tables.ai_daily_reports[0]).toMatchObject({ rolled_back: true, eval_before: 50 })
  })

  it('approves nothing when the exam has fewer than 20 cases', async () => {
    const { db, tables } = seed()
    tables.ai_eval_cases = tables.ai_eval_cases.slice(0, 10)
    mockOpenAi(0.9)
    await runNightForAccount(db, ACC, NOW)
    expect((tables.ai_knowledge_documents ?? []).filter((d) => d.source === 'advisor_learning')).toHaveLength(0)
    expect(tables.ai_learning_candidates.find((c) => c.source === 'advisor')?.verdict).toBe('pending')
    expect(String((tables.ai_daily_reports[0].summary as { exam?: { note?: string } }).exam?.note)).toMatch(/menos de 20/)
  })
})
