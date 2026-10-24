import { describe, expect, it } from 'vitest'
import {
  buildMemoryTranscript,
  failureCount,
  MAX_MEMORY_FAILURES,
  MEMORY_SCHEMA,
  pickStaleConversations,
  renderCustomerMemory,
  sanitizeMemory,
} from './memory'
import { buildSystemPrompt, NO_PRICES_GUIDANCE } from '../defaults'
import { buildExtractionPrompt } from '../schema'

describe('sanitizeMemory', () => {
  it('keeps clean fields and drops unknown keys', () => {
    expect(
      sanitizeMemory({ busca: ' mesa de trabajo ', medidas: '120 x 60 cm', otro: 'x', tono: null }),
    ).toEqual({ busca: 'mesa de trabajo', medidas: '120 x 60 cm' })
  })

  it('drops fields with prices or personal data, falling back to the previous value', () => {
    const out = sanitizeMemory(
      { busca: 'mesa de S/ 500', notas: 'su cel es 987654321', tono: 'formal', enviado: null },
      { busca: 'mesa de trabajo', enviado: 'catálogo' },
    )
    expect(out).toEqual({ busca: 'mesa de trabajo', tono: 'formal', enviado: 'catálogo' })
  })

  it('never keeps a dirty previous value', () => {
    expect(sanitizeMemory({}, { notas: 'pidió descuento' })).toEqual({})
  })
})

describe('renderCustomerMemory', () => {
  it('renders labelled lines and respects the cap', () => {
    const text = renderCustomerMemory({ busca: 'campana extractora', tipo_negocio: 'restaurante' })
    expect(text).toBe('- Busca: campana extractora\n- Tipo de negocio: restaurante')
    expect(renderCustomerMemory({ busca: 'a'.repeat(150), notas: 'b'.repeat(150) }, 170)).toBe(
      `- Busca: ${'a'.repeat(150)}`,
    )
  })
  it('is null when empty or only dirty', () => {
    expect(renderCustomerMemory({})).toBeNull()
    expect(renderCustomerMemory({ notas: 'cuesta 300' })).toBeNull()
    expect(renderCustomerMemory(null)).toBeNull()
  })
})

describe('buildMemoryTranscript', () => {
  it('labels speakers and masks amounts and personal data', () => {
    const t = buildMemoryTranscript([
      { sender_type: 'customer', content_text: 'Hola, mi número es 987 654 321' },
      { sender_type: 'agent', content_text: 'Sale S/ 1,200' },
      { sender_type: 'bot', content_text: '' },
    ])
    expect(t).toBe('Cliente: Hola, mi número es [teléfono]\nAsesor: Sale [monto]')
  })
})

describe('MEMORY_SCHEMA', () => {
  it('is strict: every field required, no extra keys', () => {
    expect(MEMORY_SCHEMA.additionalProperties).toBe(false)
    expect(MEMORY_SCHEMA.required).toEqual(['busca', 'medidas', 'tipo_negocio', 'enviado', 'tono', 'notas'])
  })
})

describe('pickStaleConversations', () => {
  const conv = (id: string, contact: string, at: string) => ({
    id,
    account_id: 'acc',
    contact_id: contact,
    last_message_at: at,
    status: 'open',
  })
  it('picks contacts with no or older memory, newest conversation per contact, capped', () => {
    const convs = [
      conv('c1', 'k1', '2026-10-20T10:00:00Z'),
      conv('c2', 'k1', '2026-10-19T10:00:00Z'),
      conv('c3', 'k2', '2026-10-20T09:00:00Z'),
      conv('c4', 'k3', '2026-10-20T08:00:00Z'),
    ]
    const mems = [
      { contact_id: 'k2', memory: {}, last_message_at_seen: '2026-10-20T09:00:00Z', cleared_at: null },
      { contact_id: 'k3', memory: {}, last_message_at_seen: '2026-10-19T00:00:00Z', cleared_at: null },
    ]
    expect(pickStaleConversations(convs, mems).map((c) => c.id)).toEqual(['c1', 'c4'])
    expect(pickStaleConversations(convs, mems, 1).map((c) => c.id)).toEqual(['c1'])
  })
})

describe('prompt injection of the memory', () => {
  it('auto-reply prompt carries the memory before the no-prices rule, which stays last', () => {
    const p = buildSystemPrompt({
      userPrompt: 'ctx',
      mode: 'auto_reply',
      knowledge: ['kb'],
      customerMemory: '- Busca: horno',
    })
    expect(p).toContain('- Busca: horno')
    expect(p.indexOf('- Busca: horno')).toBeLessThan(p.indexOf(NO_PRICES_GUIDANCE))
    expect(p.endsWith(NO_PRICES_GUIDANCE)).toBe(true)
  })

  it('no memory block without memory', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(p).not.toContain('Customer memory')
  })

  it('collect_ai prompt carries it too, before the no-prices rule', () => {
    const p = buildExtractionPrompt({
      fields: [{ key: 'producto', label: 'Producto', required: true }],
      knownValues: {},
      customerMemory: '- Medidas: 2 m',
    })
    expect(p.indexOf('- Medidas: 2 m')).toBeGreaterThan(-1)
    expect(p.endsWith(NO_PRICES_GUIDANCE)).toBe(true)
  })
})

describe('memory hardening', () => {
  it('drops fields with bare 3+ digit figures but keeps measurements', () => {
    expect(
      sanitizeMemory({ notas: 'le ofrecieron 1200', medidas: '120 x 60 cm, tanque de 500 litros', busca: 'te lo dejo en 800' }),
    ).toEqual({ medidas: '120 x 60 cm, tanque de 500 litros' })
  })

  it('hides the failure counter from the stored view and the prompt', () => {
    const raw = { busca: 'horno', _fallos: { n: 2, at: '2026-10-20T10:00:00Z' } }
    expect(sanitizeMemory(raw)).toEqual({ busca: 'horno' })
    expect(renderCustomerMemory(raw)).toBe('- Busca: horno')
  })

  it('counts failures per version of the conversation', () => {
    const raw = { _fallos: { n: 2, at: '2026-10-20T10:00:00Z' } }
    expect(failureCount(raw, '2026-10-20T10:00:00Z')).toBe(2)
    expect(failureCount(raw, '2026-10-21T10:00:00Z')).toBe(0)
    expect(failureCount(null, null)).toBe(0)
    expect(MAX_MEMORY_FAILURES).toBe(3)
  })
})
