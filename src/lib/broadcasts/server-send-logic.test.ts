import { describe, expect, it } from 'vitest'

import {
  LEASE_TTL_MS,
  finalBroadcastStatus,
  leaseBlocks,
  readLease,
  selectBatch,
  withLease,
  withoutLease,
} from './server-send-logic'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('selectBatch', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: `r${String(i).padStart(2, '0')}` }))
  it('toma como máximo 10 en el orden recibido', () => {
    expect(selectBatch(rows, new Set()).map((r) => r.id)).toEqual(rows.slice(0, 10).map((r) => r.id))
  })
  it('salta los ya intentados en esta corrida', () => {
    const got = selectBatch(rows.slice(0, 3), new Set(['r00', 'r02']))
    expect(got.map((r) => r.id)).toEqual(['r01'])
  })
  it('vacío si todos los pendientes ya se intentaron', () => {
    expect(selectBatch(rows.slice(0, 2), new Set(['r00', 'r01']))).toEqual([])
  })
})

describe('lease', () => {
  const lease = { owner: 'B', heartbeatAt: iso(NOW - 30_000), startedAt: iso(NOW - 60_000) }

  it('readLease lee audience_filter.sendLease y descarta datos rotos', () => {
    expect(readLease({ type: 'all', sendLease: lease })).toEqual(lease)
    expect(readLease({ sendLease: { owner: 'B' } })).toBeNull()
    expect(readLease(null)).toBeNull()
    expect(readLease({ sendLease: 'x' })).toBeNull()
  })

  it('otro dueño con latido reciente bloquea', () => {
    expect(leaseBlocks(lease, 'A', NOW)).toBe(true)
  })
  it('el propio dueño no se bloquea', () => {
    expect(leaseBlocks(lease, 'B', NOW)).toBe(false)
  })
  it('latido de 2 min o más no bloquea', () => {
    const old = { ...lease, heartbeatAt: iso(NOW - LEASE_TTL_MS) }
    expect(leaseBlocks(old, 'A', NOW)).toBe(false)
  })
  it('sin lease o con fecha inválida no bloquea', () => {
    expect(leaseBlocks(null, 'A', NOW)).toBe(false)
    expect(leaseBlocks({ ...lease, heartbeatAt: 'nope' }, 'A', NOW)).toBe(false)
  })
  it('un latido muy en el futuro no bloquea para siempre', () => {
    expect(leaseBlocks({ ...lease, heartbeatAt: iso(NOW + 10 * LEASE_TTL_MS) }, 'A', NOW)).toBe(false)
  })

  it('withLease / withoutLease conservan el resto del filtro', () => {
    const af = { type: 'tags', tagIds: ['t1'], headerMediaUrl: 'https://x/y.jpg' }
    const leased = withLease(af, lease)
    expect(leased).toEqual({ ...af, sendLease: lease })
    expect(withoutLease(leased)).toEqual(af)
    expect(withoutLease(null)).toEqual({})
  })
})

describe('finalBroadcastStatus', () => {
  it("'failed' solo si nadie lo recibió", () => {
    expect(finalBroadcastStatus(0)).toBe('failed')
    expect(finalBroadcastStatus(1)).toBe('sent')
  })
})
