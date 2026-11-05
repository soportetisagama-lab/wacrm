import { describe, expect, it } from 'vitest'

import {
  classifyReplyTagName,
  findTagByName,
  normalizeReplyTagName,
  repliedContactIds,
} from './reply-tag'

const TAGS = [
  { id: 't1', name: 'Interesado' },
  { id: 't2', name: ' Respondió Promo ' },
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
