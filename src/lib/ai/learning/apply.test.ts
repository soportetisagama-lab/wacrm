import { describe, expect, it, vi } from 'vitest'
import { fakeDb } from './fake-db.testutil'
import { applyProposal, type Proposal } from './apply'
import { groupAgainstLearned } from './proposals'

const ACC = 'acc-apply'

const rule = (candidateId: string): Proposal => ({
  kind: 'rule',
  candidateId,
  title: 'Regla: Pregunta primero las medidas.',
  content: 'Pregunta primero las medidas.',
  question: null,
  score: 0.95,
  support: 1,
  ready: true,
})

describe('applyProposal is idempotent', () => {
  it('a double click creates one document', async () => {
    const { db, tables } = fakeDb({
      ai_learning_candidates: [{ id: 'c1', account_id: ACC, source: 'self_review', verdict: 'pending' }],
    })
    const [a, b] = await Promise.all([
      applyProposal(db, ACC, { embeddingsApiKey: null }, rule('c1'), null),
      applyProposal(db, ACC, { embeddingsApiKey: null }, rule('c1'), null),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(tables.ai_knowledge_documents).toHaveLength(1)
    expect(tables.ai_learning_candidates[0]).toMatchObject({ verdict: 'accepted', knowledge_document_id: a ?? b })
    // A later call (e.g. the night) does nothing either.
    expect(await applyProposal(db, ACC, { embeddingsApiKey: null }, rule('c1'), 'run-1')).toBeNull()
    expect(tables.ai_knowledge_documents).toHaveLength(1)
  })

  it('releases the claim when the insert fails', async () => {
    const { db, tables } = fakeDb({
      ai_learning_candidates: [{ id: 'c2', account_id: ACC, source: 'self_review', verdict: 'pending' }],
    })
    const realFrom = db.from.bind(db)
    const spy = vi.spyOn(db, 'from').mockImplementation(((t: string) => {
      if (t === 'ai_knowledge_documents') {
        return { insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }
      }
      return realFrom(t)
    }) as typeof db.from)
    expect(await applyProposal(db, ACC, { embeddingsApiKey: null }, rule('c2'), null)).toBeNull()
    expect(tables.ai_learning_candidates[0].verdict).toBe('pending')
    spy.mockRestore()
  })

  it('never applies a proposal with a price', async () => {
    const { db, tables } = fakeDb({
      ai_learning_candidates: [{ id: 'c3', account_id: ACC, source: 'self_review', verdict: 'pending' }],
    })
    const bad = { ...rule('c3'), content: 'Si duda, te lo dejo en 900' }
    expect(await applyProposal(db, ACC, { embeddingsApiKey: null }, bad, null)).toBeNull()
    expect(tables.ai_knowledge_documents ?? []).toHaveLength(0)
    expect(tables.ai_learning_candidates[0].verdict).toBe('pending')
  })
})

describe('groupAgainstLearned', () => {
  it('flags groups similar to an already learned question', () => {
    // items 0,1 similar to each other and to learned item 3; item 2 is new
    const v = [[1, 0], [0.99, 0.05], [0, 1], [1, 0.01]]
    const sim = (i: number, j: number) => {
      const a = v[i]
      const b = v[j]
      return (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b))
    }
    expect(groupAgainstLearned(3, 1, sim, 0.9)).toEqual([
      { members: [0, 1], learned: true },
      { members: [2], learned: false },
    ])
  })
})
