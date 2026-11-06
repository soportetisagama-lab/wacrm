import { describe, expect, it } from 'vitest'

import {
  classifyReplyTagName,
  findTagByName,
  newBroadcastTagRow,
  normalizeReplyTagName,
  repliedContactIds,
} from './reply-tag'

const TAGS = [
  { id: 't1', name: 'Interesado', is_broadcast: true },
  { id: 't2', name: ' Respondió Promo ', is_broadcast: true },
]

describe('normalizeReplyTagName', () => {
  it('recorta espacios y trata vacío/null como vacío', () => {
    expect(normalizeReplyTagName('  Hola ')).toBe('Hola')
    expect(normalizeReplyTagName('   ')).toBe('')
    expect(normalizeReplyTagName(null)).toBe('')
  })
})

describe('findTagByName', () => {
  it('encuentra sin importar mayúsculas ni espacios', () => {
    expect(findTagByName(TAGS, 'interesado')?.id).toBe('t1')
    expect(findTagByName(TAGS, 'RESPONDIÓ PROMO')?.id).toBe('t2')
  })
  it('null si no hay coincidencia o el nombre está vacío', () => {
    expect(findTagByName(TAGS, 'Otro')).toBeNull()
    expect(findTagByName(TAGS, '  ')).toBeNull()
  })
})

describe('classifyReplyTagName', () => {
  it('none, existing o new', () => {
    expect(classifyReplyTagName(TAGS, '')).toEqual({ kind: 'none' })
    expect(classifyReplyTagName(TAGS, 'INTERESADO')).toEqual({ kind: 'existing', tag: TAGS[0] })
    expect(classifyReplyTagName(TAGS, ' Nueva ')).toEqual({ kind: 'new', name: 'Nueva' })
  })

  it('nunca reutiliza una etiqueta comercial o personal con el mismo nombre', () => {
    const mixed = [
      { id: 'c1', name: 'VIP', is_shared: true, is_broadcast: false },
      { id: 'p1', name: 'Seguir', is_shared: false },
      { id: 'b1', name: 'vip', is_broadcast: true },
    ]
    expect(classifyReplyTagName(mixed, 'VIP')).toEqual({ kind: 'existing', tag: mixed[2] })
    expect(classifyReplyTagName(mixed, 'Seguir')).toEqual({ kind: 'new', name: 'Seguir' })
    expect(classifyReplyTagName(mixed.slice(0, 2), 'vip')).toEqual({ kind: 'new', name: 'vip' })
  })
})

describe('newBroadcastTagRow', () => {
  it('crea la etiqueta compartida y de difusión, con el nombre recortado', () => {
    expect(newBroadcastTagRow({ accountId: 'acc', userId: 'u', name: '  Promo  ' })).toEqual({
      user_id: 'u',
      account_id: 'acc',
      name: 'Promo',
      color: '#3b82f6',
      is_shared: true,
      is_broadcast: true,
    })
  })
})

describe('repliedContactIds', () => {
  it('solo replied, sin nulos y sin repetidos', () => {
    expect(
      repliedContactIds([
        { contact_id: 'a', status: 'replied' },
        { contact_id: 'a', status: 'replied' },
        { contact_id: null, status: 'replied' },
        { contact_id: 'b', status: 'read' },
        { contact_id: 'c', status: 'replied' },
      ]),
    ).toEqual(['a', 'c'])
  })
})
