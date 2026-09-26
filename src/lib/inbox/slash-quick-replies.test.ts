import { describe, it, expect } from 'vitest'
import type { QuickReply } from '@/types'
import { findSlashToken, matchSlashQuickReplies, replaceSlashToken } from './slash-quick-replies'

const qr = (title: string, content_text = ''): QuickReply =>
  ({ id: title, title, content_text, kind: 'text', is_shared: false } as QuickReply)

describe('findSlashToken', () => {
  it('finds "/name" at the start and after a space', () => {
    expect(findSlashToken('/sal', 4)).toEqual({ start: 0, end: 4, query: 'sal' })
    expect(findSlashToken('Hola /m1', 8)).toEqual({ start: 5, end: 8, query: 'm1' })
  })

  it('a bare "/" opens the list with an empty query', () => {
    expect(findSlashToken('/', 1)).toEqual({ start: 0, end: 1, query: '' })
  })

  it('ignores URLs, dates and a finished word', () => {
    expect(findSlashToken('https://sagama.pe', 17)).toBeNull()
    expect(findSlashToken('el 26/09', 8)).toBeNull()
    expect(findSlashToken('/sal ', 5)).toBeNull()
  })

  it('only looks at the text before the caret', () => {
    expect(findSlashToken('/sal resto', 4)).toEqual({ start: 0, end: 4, query: 'sal' })
  })
})

describe('matchSlashQuickReplies', () => {
  const items = [qr('Precios', 'lista'), qr('saludo inicial', 'Hola!'), qr('m1', 'Gracias por comunicarte'), qr('Catálogo')]

  it('ranks name prefix, then name contains, then text contains; accent-insensitive', () => {
    expect(matchSlashQuickReplies(items, 'sal').map((r) => r.title)).toEqual(['saludo inicial'])
    expect(matchSlashQuickReplies(items, 'catalogo').map((r) => r.title)).toEqual(['Catálogo'])
    expect(matchSlashQuickReplies(items, 'gracias').map((r) => r.title)).toEqual(['m1'])
    expect(matchSlashQuickReplies(items, 'i').map((r) => r.title)).toEqual(['Precios', 'saludo inicial', 'm1'])
  })

  it('an empty query lists everything up to the limit', () => {
    expect(matchSlashQuickReplies(items, '', 2)).toHaveLength(2)
  })
})

describe('replaceSlashToken', () => {
  it('swaps the token for the reply and puts the caret after it', () => {
    const token = findSlashToken('Hola /m1 chau', 8)!
    expect(replaceSlashToken('Hola /m1 chau', token, 'Gracias')).toEqual({
      text: 'Hola Gracias chau',
      caret: 12,
    })
  })
})
