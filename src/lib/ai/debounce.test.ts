import { describe, it, expect, vi } from 'vitest'
import { runDebounced, summarizePendingBurst, PROCESSING_LOCK_SECONDS } from './debounce'

type Row = {
  sender_type: string
  content_type: string
  content_text: string | null
  transcript?: string | null
  is_sticker?: boolean | null
  created_at: string
}

/** Fake client: `messages` reads return `rows` (newest-first); the
 *  debounce window reads come from `windowQueue`, one per read. */
function fakeDb(rows: Row[] | null, windowQueue: (string | null)[] = []) {
  return {
    from: (table: string) => {
      if (table === 'messages') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve(rows ? { data: rows, error: null } : { data: null, error: { message: 'x' } }),
        }
        return chain
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              const next = windowQueue.shift() ?? null
              return Promise.resolve({ data: next ? { ai_debounce_until: next } : null, error: null })
            },
          }),
        }),
        update: () => {
          const done = Promise.resolve({ error: null })
          return { eq: () => Object.assign(done, { lte: () => done }) }
        },
      }
    },
    rpc: () =>
      Promise.resolve({
        data: [{ is_owner: true, wait_until: new Date(Date.now() - 1000).toISOString() }],
        error: null,
      }),
  } as never
}

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

describe('summarizePendingBurst', () => {
  it('default: only what the customer sent since the business last wrote', async () => {
    const burst = await summarizePendingBurst(
      fakeDb([
        { sender_type: 'customer', content_type: 'image', content_text: null, created_at: at(1000) },
        { sender_type: 'bot', content_type: 'text', content_text: 'Hola', created_at: at(2000) },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola', created_at: at(3000) },
      ]),
      'conv-1',
    )
    expect(burst).toEqual({ count: 1, hasText: false, hasImage: true })
  })

  it('a rerun counts the text that arrived during the reply, even though the reply is now the newest message', async () => {
    const turnStart = Date.now() - 5000
    const rows: Row[] = [
      { sender_type: 'bot', content_type: 'text', content_text: '¿Qué medida?', created_at: at(1000) },
      { sender_type: 'customer', content_type: 'text', content_text: 'y en acero', created_at: at(3000) },
      { sender_type: 'customer', content_type: 'text', content_text: 'quiero una mesa', created_at: at(8000) },
    ]
    // The old behavior: nothing since the bot wrote → empty burst.
    expect(await summarizePendingBurst(fakeDb(rows), 'conv-1')).toEqual({
      count: 0,
      hasText: false,
      hasImage: false,
    })
    // With the previous turn's start: only the new text, not the one already answered.
    expect(await summarizePendingBurst(fakeDb(rows), 'conv-1', { since: turnStart })).toEqual({
      count: 1,
      hasText: true,
      hasImage: false,
    })
  })

  it('a rerun with nothing new reports count 0 (the caller answers nothing)', async () => {
    const burst = await summarizePendingBurst(
      fakeDb([
        { sender_type: 'bot', content_type: 'text', content_text: 'Listo', created_at: at(500) },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola', created_at: at(9000) },
      ]),
      'conv-1',
      { since: Date.now() - 5000 },
    )
    expect(burst?.count).toBe(0)
  })

  it('orphaned: when the business wrote last, counts what arrived during that reply only', async () => {
    const recent = await summarizePendingBurst(
      fakeDb([
        { sender_type: 'bot', content_type: 'text', content_text: 'Hola', created_at: at(1000) },
        { sender_type: 'customer', content_type: 'text', content_text: 'y en acero', created_at: at(4000) },
      ]),
      'conv-1',
      { orphaned: true },
    )
    expect(recent).toEqual({ count: 1, hasText: true, hasImage: false })

    const old = await summarizePendingBurst(
      fakeDb([
        { sender_type: 'bot', content_type: 'text', content_text: 'Hola', created_at: at(1000) },
        {
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'hola',
          created_at: at(1000 + (PROCESSING_LOCK_SECONDS + 5) * 1000),
        },
      ]),
      'conv-1',
      { orphaned: true },
    )
    expect(old?.count).toBe(0)
  })

  it('returns null when the read fails', async () => {
    expect(await summarizePendingBurst(fakeDb(null), 'conv-1')).toBeNull()
  })
})

describe('runDebounced', () => {
  it('passes rerunSince = the previous turn start on a rerun, null on the first turn', async () => {
    const turns: (number | null)[] = []
    // settle read, then "a message extended the lock", then clear.
    const queue: (string | null)[] = [null]
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const before = Date.now()
      const p = runDebounced(fakeDb([], queue), 'conv-1', async ({ rerunSince }) => {
        turns.push(rerunSince)
        if (turns.length === 1) queue.push(new Date(Date.now() + 60_000).toISOString(), null)
      })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await p).toBe('done')
      expect(turns).toHaveLength(2)
      expect(turns[0]).toBeNull()
      expect(turns[1]).toBeGreaterThanOrEqual(before)
      expect(turns[1]).toBeLessThanOrEqual(before + 1000)
    } finally {
      vi.useRealTimers()
    }
  })
})
