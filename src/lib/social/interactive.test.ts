import { describe, expect, it } from 'vitest'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { matchNumberedReply, menuOptions, toSocialMenu } from './interactive'

const BUTTONS: InteractiveMessagePayload = {
  kind: 'buttons',
  body: '¿Qué necesitas?',
  buttons: [
    { id: 'cotizar', title: 'Cotizar' },
    { id: 'catalogo', title: '🖼️ Catálogo digital' },
  ],
}

const LIST_WITH_DESCRIPTIONS: InteractiveMessagePayload = {
  kind: 'list',
  body: 'Elige una opción',
  button_label: 'Ver opciones',
  sections: [
    {
      rows: [
        { id: 'r1', title: 'Cocinas', description: 'Industriales y de casa' },
        { id: 'r2', title: 'Campanas' },
        { id: 'r3', title: 'Mesas de trabajo' },
      ],
    },
  ],
}

describe('toSocialMenu', () => {
  it('sends short options as quick replies with the option id as payload', () => {
    const menu = toSocialMenu(BUTTONS)
    expect(menu.mode).toBe('quick_replies')
    if (menu.mode !== 'quick_replies') return
    expect(menu.text).toBe('¿Qué necesitas?')
    expect(menu.quickReplies).toEqual([
      { content_type: 'text', title: 'Cotizar', payload: 'cotizar' },
      { content_type: 'text', title: '🖼️ Catálogo digital', payload: 'catalogo' },
    ])
  })

  it('falls back to numbered text when rows carry descriptions', () => {
    const menu = toSocialMenu(LIST_WITH_DESCRIPTIONS)
    expect(menu.mode).toBe('numbered')
    expect(menu.text).toContain('1. Cocinas — Industriales y de casa')
    expect(menu.text).toContain('3. Mesas de trabajo')
    expect(menu.text).toContain('Responde con el número')
  })

  it('falls back to numbered text when a title is longer than 20 characters', () => {
    const menu = toSocialMenu({
      kind: 'list',
      body: 'x',
      button_label: 'Ver',
      sections: [{ rows: [{ id: 'a', title: 'Una opción demasiado larga' }] }],
    })
    expect(menu.mode).toBe('numbered')
  })

  it('falls back to numbered text with more than 13 options', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: `o${i}`, title: `Op ${i}` }))
    const menu = toSocialMenu({ kind: 'list', body: 'x', button_label: 'Ver', sections: [{ rows }] })
    expect(menu.mode).toBe('numbered')
  })
})

describe('matchNumberedReply', () => {
  it('maps a number to the option in display order', () => {
    expect(matchNumberedReply('2', LIST_WITH_DESCRIPTIONS)?.id).toBe('r2')
    expect(matchNumberedReply(' 3. ', LIST_WITH_DESCRIPTIONS)?.id).toBe('r3')
    expect(matchNumberedReply('opción 1', LIST_WITH_DESCRIPTIONS)?.id).toBe('r1')
  })

  it('maps the exact title, ignoring accents, case and emoji', () => {
    expect(matchNumberedReply('catalogo digital', BUTTONS)?.id).toBe('catalogo')
    expect(matchNumberedReply('COTIZAR', BUTTONS)?.id).toBe('cotizar')
  })

  it('returns null for out-of-range numbers and free text', () => {
    expect(matchNumberedReply('9', LIST_WITH_DESCRIPTIONS)).toBeNull()
    expect(matchNumberedReply('quiero una cocina de 2 metros', LIST_WITH_DESCRIPTIONS)).toBeNull()
    expect(matchNumberedReply('', BUTTONS)).toBeNull()
  })

  it('lists options across sections in order', () => {
    expect(menuOptions(LIST_WITH_DESCRIPTIONS).map((o) => o.id)).toEqual(['r1', 'r2', 'r3'])
  })
})
