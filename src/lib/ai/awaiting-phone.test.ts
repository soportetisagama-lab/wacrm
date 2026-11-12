import { describe, it, expect } from 'vitest'
import {
  ASK_PHONE_TEXT,
  MAX_PHONE_ASKS,
  awaitingPhoneSummary,
  handoffDoneWithoutPhone,
  parseAwaitingPhone,
} from './awaiting-phone'

describe('awaitingPhoneSummary / parseAwaitingPhone', () => {
  it('round-trips the ask count and the advisor note', () => {
    const note = '🤖 El asistente derivó la conversación.\nCliente pidió cotización'
    expect(parseAwaitingPhone(awaitingPhoneSummary(2, note))).toEqual({
      asks: 2,
      summary: note,
      options: {},
    })
  })

  it("round-trips a flow's own closing texts and assignee", () => {
    const options = {
      closing: 'Ya te derivo, ¡gracias!',
      closingAfterHours: 'Te escribimos {{proxima_apertura}}.',
      assignTo: 'agent-9',
    }
    const marker = awaitingPhoneSummary(1, '🤖 El bot derivó la conversación a un asesor.', options)
    expect(parseAwaitingPhone(marker)).toEqual({
      asks: 1,
      summary: '🤖 El bot derivó la conversación a un asesor.',
      options,
    })
  })

  it('drops empty options instead of writing a settings line', () => {
    expect(awaitingPhoneSummary(1, 'Nota', { closing: '  ', assignTo: undefined })).toBe(
      `${awaitingPhoneSummary(1, 'Nota')}`,
    )
    expect(awaitingPhoneSummary(1, 'Nota')).not.toContain('⚙')
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

describe('handoffDoneWithoutPhone', () => {
  const note = '🤖 El asistente derivó la conversación.'

  it('is true after a give-up handoff (pending, bot off, no held marker)', () => {
    expect(handoffDoneWithoutPhone({ status: 'pending', ai_autoreply_disabled: true, ai_handoff_summary: note })).toBe(true)
    expect(handoffDoneWithoutPhone({ status: 'pending', ai_autoreply_disabled: true, ai_handoff_summary: null })).toBe(true)
  })

  it('is false while the handoff is still on hold for the number', () => {
    expect(
      handoffDoneWithoutPhone({
        status: 'pending',
        ai_autoreply_disabled: true,
        ai_handoff_summary: awaitingPhoneSummary(MAX_PHONE_ASKS, note),
      }),
    ).toBe(false)
  })

  it('is false for a welcome stopped at its phone gate (no handoff yet)', () => {
    expect(handoffDoneWithoutPhone({ status: 'open', ai_autoreply_disabled: false, ai_handoff_summary: null })).toBe(false)
  })

  it('is false for a manual pause or the spam close (status stays open)', () => {
    expect(handoffDoneWithoutPhone({ status: 'open', ai_autoreply_disabled: true, ai_handoff_summary: null })).toBe(false)
    expect(
      handoffDoneWithoutPhone({ status: 'open', ai_autoreply_disabled: true, ai_handoff_summary: '🚫 Posible spam: x' }),
    ).toBe(false)
  })

  it('is false for pending with the bot still on, closed chats or a missing row', () => {
    expect(handoffDoneWithoutPhone({ status: 'pending', ai_autoreply_disabled: false })).toBe(false)
    expect(handoffDoneWithoutPhone({ status: 'closed', ai_autoreply_disabled: true })).toBe(false)
    expect(handoffDoneWithoutPhone(null)).toBe(false)
  })
})
