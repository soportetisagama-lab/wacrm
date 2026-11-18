import { describe, expect, it, vi } from 'vitest'

import {
  asignarDesdeAlertaAtc,
  leerAlertaAtc,
  notaDerivadoPorAtc,
  type AlertaAtcInput,
  type AlertaAtcStore,
} from './derivacion-alerta-atc'

function store(over: Partial<AlertaAtcStore> = {}): AlertaAtcStore {
  return {
    loadConversation: vi.fn(async (id: string) =>
      id === 'conv-1' || id === 'conv-2' ? { account_id: 'acc', channel: 'whatsapp', contact_id: 'k' } : null,
    ),
    findAgentByXlr8: vi.fn(async (_acc: string, id: number) => (id === 7 ? 'user-7' : null)),
    assign: vi.fn(async () => true),
    appendNote: vi.fn(async () => undefined),
    findConversationByCelular: vi.fn(async () => 'conv-2'),
    ...over,
  }
}

const base: AlertaAtcInput = {
  conversationId: 'conv-1',
  celular: '961522577',
  asesorId: 7,
  asesorNombre: 'Patricia',
  antesDe: 'Daniela',
  mismoAsesor: false,
}

describe('leerAlertaAtc', () => {
  it('acepta el cuerpo del PHP', () => {
    expect(leerAlertaAtc({ conversation_id: 'conv-1', celular: '961522577', asesor_id: '7', asesor_nombre: 'Patricia', antes_de: 'Daniela' })).toEqual(base)
  })
  it('rechaza sin asesor o sin chat ni celular', () => {
    expect(leerAlertaAtc({ conversation_id: 'conv-1' })).toBeNull()
    expect(leerAlertaAtc({ asesor_id: 7, celular: '12' })).toBeNull()
  })
})

describe('asignarDesdeAlertaAtc', () => {
  it('asigna por conversation_id y deja la nota', async () => {
    const s = store()
    expect(await asignarDesdeAlertaAtc(s, base)).toEqual({ ok: true, conversationId: 'conv-1' })
    expect(s.assign).toHaveBeenCalledWith('conv-1', 'user-7')
    expect(s.appendNote).toHaveBeenCalledWith('conv-1', 'Derivado por ATC a Patricia (XLR8), antes cliente de Daniela')
  })

  it('sin conversation_id busca por celular', async () => {
    const s = store()
    expect(await asignarDesdeAlertaAtc(s, { ...base, conversationId: '' })).toEqual({ ok: true, conversationId: 'conv-2' })
    expect(s.findConversationByCelular).toHaveBeenCalledWith('961522577')
  })

  it('sin chat responde sin_conversacion', async () => {
    const s = store({ findConversationByCelular: vi.fn(async () => null) })
    expect(await asignarDesdeAlertaAtc(s, { ...base, conversationId: 'x' })).toEqual({ ok: false, motivo: 'sin_conversacion' })
  })

  it('sin usuario con ese ID XLR8 no asigna', async () => {
    const s = store()
    expect(await asignarDesdeAlertaAtc(s, { ...base, asesorId: 99 })).toEqual({ ok: false, motivo: 'sin_usuario' })
    expect(s.assign).not.toHaveBeenCalled()
  })

  it('nota para su mismo asesor', () => {
    expect(notaDerivadoPorAtc({ ...base, mismoAsesor: true, antesDe: '' })).toBe('Derivado por ATC a su mismo asesor Patricia (XLR8)')
  })
})
