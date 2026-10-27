import { describe, it, expect } from 'vitest'
import { ASK_PHONE_TEXT, MAX_PHONE_ASKS, awaitingPhoneSummary, parseAwaitingPhone } from './awaiting-phone'

describe('awaitingPhoneSummary / parseAwaitingPhone', () => {
  it('round-trips the ask count and the advisor note', () => {
    const note = '🤖 El asistente derivó la conversación.\nCliente pidió cotización'
    expect(parseAwaitingPhone(awaitingPhoneSummary(2, note))).toEqual({ asks: 2, summary: note })
  })

  it('is null for a normal note, an advisor brief or nothing', () => {
    expect(parseAwaitingPhone(null)).toBeNull()
    expect(parseAwaitingPhone('')).toBeNull()
    expect(parseAwaitingPhone('📋 Producto: mesa')).toBeNull()
    expect(parseAwaitingPhone('🤖 El asistente derivó la conversación a un asesor.')).toBeNull()
  })

  it('caps at 3 asks and asks in neutral Spanish', () => {
    expect(MAX_PHONE_ASKS).toBe(3)
    expect(ASK_PHONE_TEXT).toBe('Para ayudarte mejor, ¿nos compartes tu número de celular?')
  })
})
