import { describe, expect, it } from 'vitest'

import {
  groupAudienceTags,
  isBroadcastTag,
  onlyBroadcastTags,
  withoutBroadcastTags,
} from './broadcast-tags'

const TAGS = [
  { id: 'a', is_broadcast: true },
  { id: 'b', is_broadcast: false },
  { id: 'c' },
  { id: 'd', is_broadcast: null },
]

describe('isBroadcastTag', () => {
  it('solo true cuando está marcada explícitamente', () => {
    expect(isBroadcastTag({ is_broadcast: true })).toBe(true)
    expect(isBroadcastTag({ is_broadcast: false })).toBe(false)
    expect(isBroadcastTag({})).toBe(false)
    expect(isBroadcastTag(null)).toBe(false)
    expect(isBroadcastTag(undefined)).toBe(false)
  })
})

describe('withoutBroadcastTags / onlyBroadcastTags', () => {
  it('separa las de difusión de las normales (sin columna = normal)', () => {
    expect(withoutBroadcastTags(TAGS).map((t) => t.id)).toEqual(['b', 'c', 'd'])
    expect(onlyBroadcastTags(TAGS).map((t) => t.id)).toEqual(['a'])
  })
  it('tolera null/undefined', () => {
    expect(withoutBroadcastTags(null)).toEqual([])
    expect(onlyBroadcastTags(undefined)).toEqual([])
  })
})

describe('groupAudienceTags', () => {
  it('equipo (compartidas, no de difusión) y difusión por separado; sin personales', () => {
    const tags = [
      { id: 'team', is_shared: true },
      { id: 'legacy' },
      { id: 'personal', is_shared: false },
      { id: 'promo', is_shared: true, is_broadcast: true },
    ]
    const { team, broadcast } = groupAudienceTags(tags)
    expect(team.map((t) => t.id)).toEqual(['team', 'legacy'])
    expect(broadcast.map((t) => t.id)).toEqual(['promo'])
  })
})
