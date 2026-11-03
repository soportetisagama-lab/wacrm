import { describe, expect, it } from 'vitest'

import { metaErrorText } from './meta-error-text'

describe('metaErrorText', () => {
  it('traduce el límite de marketing (131049)', () => {
    expect(
      metaErrorText('This message was not delivered to maintain healthy ecosystem engagement.'),
    ).toMatch(/límite de mensajes de marketing/)
  })

  it('traduce la ventana de 24 h (131047)', () => {
    expect(metaErrorText('Re-engagement message')).toMatch(/24 h/)
  })

  it('deja el texto original si no lo conoce', () => {
    expect(metaErrorText('Something else')).toBe('Something else')
  })

  it('devuelve null si no hay error', () => {
    expect(metaErrorText(null)).toBeNull()
    expect(metaErrorText('  ')).toBeNull()
  })
})
