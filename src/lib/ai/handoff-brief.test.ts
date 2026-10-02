import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ generateReply: vi.fn() }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))

import { buildBriefPrompt, generateHandoffBrief } from './handoff-brief'
import type { AiConfig } from './types'

const config = {
  provider: 'openai',
  model: 'gpt-test',
  apiKey: 'sk-test',
  systemPrompt: 'Vendemos góndolas.',
} as AiConfig

beforeEach(() => h.generateReply.mockReset())

describe('generateHandoffBrief', () => {
  it('sends the chat as one transcript and prefixes the note', async () => {
    h.generateReply.mockResolvedValue({ text: 'Producto: góndola\nDistrito: SJL', usage: null })
    const result = await generateHandoffBrief({
      config,
      messages: [
        { role: 'assistant', content: '¿Qué necesitas?' },
        { role: 'user', content: 'una góndola, estoy en SJL' },
      ],
    })
    expect(result?.brief).toBe('📋 Producto: góndola\nDistrito: SJL')
    const call = h.generateReply.mock.calls[0][0]
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0].content).toContain('Cliente: una góndola, estoy en SJL')
    expect(call.messages[0].content).toContain('Empresa: ¿Qué necesitas?')
  })

  it('skips the model call when the customer said nothing', async () => {
    expect(
      await generateHandoffBrief({ config, messages: [{ role: 'assistant', content: 'Hola' }] }),
    ).toBeNull()
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('returns null on a provider failure or empty output', async () => {
    h.generateReply.mockRejectedValueOnce(new Error('boom'))
    const messages = [{ role: 'user' as const, content: 'hola' }]
    expect(await generateHandoffBrief({ config, messages })).toBeNull()
    h.generateReply.mockResolvedValueOnce({ text: '  ', usage: null })
    expect(await generateHandoffBrief({ config, messages })).toBeNull()
  })

  it('caps a runaway note', async () => {
    h.generateReply.mockResolvedValue({ text: 'x'.repeat(2000), usage: null })
    const result = await generateHandoffBrief({ config, messages: [{ role: 'user', content: 'hola' }] })
    expect(result!.brief.length).toBeLessThanOrEqual(603)
  })
})

describe('buildBriefPrompt', () => {
  it('includes the business context as reference', () => {
    expect(buildBriefPrompt('Vendemos góndolas.')).toContain('Vendemos góndolas.')
  })
})
