import { describe, it, expect } from 'vitest'
import { anchorCalls, CALLS_START, type ThreadCall } from './call-log'

const msg = (id: string, at: string) => ({ id, created_at: at })
const call = (id: string, at: string): ThreadCall => ({
  id,
  status: 'missed',
  duration_seconds: null,
  created_at: at,
})

describe('anchorCalls', () => {
  it('places each call after the last message sent before it', () => {
    const messages = [
      msg('m1', '2026-09-29T10:00:00Z'),
      msg('m2', '2026-09-29T10:05:00Z'),
    ]
    const out = anchorCalls(messages, [
      call('c0', '2026-09-29T09:00:00Z'),
      call('c1', '2026-09-29T10:01:00Z'),
      call('c2', '2026-09-29T10:02:00Z'),
      call('c3', '2026-09-29T11:00:00Z'),
    ])
    expect(out.get(CALLS_START)?.map((c) => c.id)).toEqual(['c0'])
    expect(out.get('m1')?.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(out.get('m2')?.map((c) => c.id)).toEqual(['c3'])
  })
})
