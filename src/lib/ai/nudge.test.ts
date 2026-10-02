import { describe, expect, it } from 'vitest'
import { isSafeNudge } from './nudge'

describe('isSafeNudge', () => {
  it('accepts a short catchy follow-up', () => {
    expect(isSafeNudge('Tu góndola te espera 👀 ¿Seguimos con tu cotización?')).toBe(true)
  })

  it.each([
    'Tu cocina con 10% de descuento te espera',
    '¡Oferta solo por hoy! ¿Seguimos?',
    'Tu rack desde S/ 500 te espera',
    'Quedan pocos lockers, ¿seguimos?',
    '¿Sigues ahí? Quedé esperando tu respuesta',
    'Te regalamos la instalación 🙌',
  ])('rejects commercial promises and the old wording: %s', (text) => {
    expect(isSafeNudge(text)).toBe(false)
  })

  it('rejects empty and overly long text', () => {
    expect(isSafeNudge('   ')).toBe(false)
    expect(isSafeNudge('a'.repeat(161))).toBe(false)
  })
})
