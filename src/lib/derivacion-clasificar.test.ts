import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/ai/config', () => ({ loadAiConfig: vi.fn() }))
vi.mock('@/lib/ai/providers/openai', () => ({ generateOpenAiStructured: vi.fn() }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: vi.fn(async () => undefined) }))

import { loadAiConfig } from '@/lib/ai/config'
import { generateOpenAiStructured } from '@/lib/ai/providers/openai'
import {
  armarTranscripcion,
  clasificadorOpenAi,
  parseClasificacion,
  CLASIFICACION_LEAD,
  CLASIFICAR_TIMEOUT_MS,
} from './derivacion-clasificar'

const loadAiConfigMock = vi.mocked(loadAiConfig)
const generateMock = vi.mocked(generateOpenAiStructured)

/** DB mínima: solo `messages` (orden descendente, como la consulta real). */
function fakeDb(rows: { sender_type: string; content_text: string | null; transcript?: string | null }[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: async () => ({ data: [...rows].reverse(), error: null }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

const CONFIG = {
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  systemPrompt: 'Vendemos acero inoxidable.',
  isActive: true,
}

const INPUT = { accountId: 'acc-1', conversationId: 'conv-1', numeroExtranjero: true }

beforeEach(() => {
  loadAiConfigMock.mockReset()
  generateMock.mockReset()
})

describe('parseClasificacion', () => {
  it('acepta lead y atc con motivo válido', () => {
    expect(parseClasificacion({ tipo: 'lead', motivo: '' })).toEqual(CLASIFICACION_LEAD)
    expect(parseClasificacion({ tipo: 'atc', motivo: 'proveedor' })).toEqual({ tipo: 'atc', motivo: 'proveedor' })
  })
  it('rechaza lo inválido', () => {
    expect(parseClasificacion({ tipo: 'atc', motivo: '' })).toBeNull()
    expect(parseClasificacion({ tipo: 'otro' })).toBeNull()
    expect(parseClasificacion(null)).toBeNull()
  })
})

describe('armarTranscripcion', () => {
  it('pasa el dato de número extranjero y oculta teléfonos', () => {
    const t = armarTranscripcion([{ de: 'Cliente', texto: 'Llámame al +1 202 555 0100' }], true)
    expect(t).toContain('Número extranjero: sí')
    expect(t).toContain('Cliente: Llámame al [número]')
    expect(t).not.toContain('555')
  })
})

describe('clasificadorOpenAi', () => {
  const db = fakeDb([
    { sender_type: 'customer', content_text: 'Hola, quiero cotizar planchas para una obra en Lima' },
    { sender_type: 'bot', content_text: '¿Qué medidas necesitas?' },
  ])

  it('usa OpenAI con la config de la cuenta y devuelve la decisión de la IA', async () => {
    loadAiConfigMock.mockResolvedValue(CONFIG as never)
    generateMock.mockResolvedValue({ data: { tipo: 'lead', motivo: '' }, usage: null })
    expect(await clasificadorOpenAi(db)(INPUT)).toEqual(CLASIFICACION_LEAD)
    const args = generateMock.mock.calls[0][0]
    expect(args.apiKey).toBe('sk-test')
    expect(args.timeoutMs).toBe(CLASIFICAR_TIMEOUT_MS)
    expect(args.temperature).toBe(0)
    const content = args.messages[0].content as string
    expect(content).toContain('Número extranjero: sí')
    expect(content).toContain('Cliente: Hola, quiero cotizar')
    expect(content).toContain('Bot: ¿Qué medidas necesitas?')
  })

  it('devuelve atc cuando la IA lo decide', async () => {
    loadAiConfigMock.mockResolvedValue(CONFIG as never)
    generateMock.mockResolvedValue({ data: { tipo: 'atc', motivo: 'trabajo' }, usage: null })
    expect(await clasificadorOpenAi(db)(INPUT)).toEqual({ tipo: 'atc', motivo: 'trabajo' })
  })

  it('IA caída, sin saldo o respuesta inválida → lead', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadAiConfigMock.mockResolvedValue(CONFIG as never)
    generateMock.mockRejectedValueOnce(new Error('insufficient_quota'))
    expect(await clasificadorOpenAi(db)(INPUT)).toEqual(CLASIFICACION_LEAD)
    generateMock.mockResolvedValueOnce({ data: { tipo: 'quizás' }, usage: null })
    expect(await clasificadorOpenAi(db)(INPUT)).toEqual(CLASIFICACION_LEAD)
    expect(err).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })

  it('nunca usa otro proveedor: si la cuenta no es OpenAI, va como lead', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadAiConfigMock.mockResolvedValue({ ...CONFIG, provider: 'anthropic' } as never)
    expect(await clasificadorOpenAi(db)(INPUT)).toEqual(CLASIFICACION_LEAD)
    expect(generateMock).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
