import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  generateOpenAiStructured: vi.fn(),
  generateAnthropicStructured: vi.fn(),
  logAiUsage: vi.fn(),
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./providers/openai', () => ({ generateOpenAiStructured: h.generateOpenAiStructured }))
vi.mock('./providers/anthropic', () => ({
  generateAnthropicStructured: h.generateAnthropicStructured,
}))
vi.mock('./usage', () => ({ logAiUsage: h.logAiUsage }))

import { classifyFirstInboundContext, parseClassification } from './classify-first-inbound'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    transcribeAudioEnabled: false,
    visionEnabled: false,
    documents: [],
    ...overrides,
  }
}

const fakeDb = {} as never // never touched directly — loadAiConfig/logAiUsage are mocked

beforeEach(() => {
  vi.clearAllMocks()
  h.loadAiConfig.mockResolvedValue(config())
  h.generateOpenAiStructured.mockResolvedValue({
    data: { has_context: true, reason: 'mentions a specific product' },
    usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
  })
  h.generateAnthropicStructured.mockResolvedValue({
    data: { has_context: true, reason: 'mentions a specific product' },
    usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
  })
})

describe('parseClassification', () => {
  it('reads has_context and reason from a well-formed response', () => {
    expect(parseClassification({ has_context: true, reason: 'quiere cotizar' })).toEqual({
      hasContext: true,
      reason: 'quiere cotizar',
    })
  })

  it('defaults to hasContext:false on a missing/malformed response, same defensive philosophy as parseExtraction', () => {
    expect(parseClassification(null)).toEqual({ hasContext: false, reason: '' })
    expect(parseClassification({})).toEqual({ hasContext: false, reason: '' })
    expect(parseClassification({ has_context: 'yes' })).toEqual({ hasContext: false, reason: '' })
    expect(parseClassification({ has_context: true, reason: 42 })).toEqual({
      hasContext: true,
      reason: '',
    })
  })

  it('trims the reason', () => {
    expect(parseClassification({ has_context: false, reason: '  saludo genérico  ' })).toEqual({
      hasContext: false,
      reason: 'saludo genérico',
    })
  })
})

describe('classifyFirstInboundContext — short-circuit', () => {
  it('never calls the model for a message shorter than the threshold', async () => {
    const result = await classifyFirstInboundContext(fakeDb, 'acct-1', 'conv-1', 'Hola')
    expect(result.hasContext).toBe(false)
    expect(h.loadAiConfig).not.toHaveBeenCalled()
    expect(h.generateOpenAiStructured).not.toHaveBeenCalled()
  })

  it('short-circuits on a bare emoji / whitespace-padded trivial message', async () => {
    const result = await classifyFirstInboundContext(fakeDb, 'acct-1', 'conv-1', '   👋   ')
    expect(result.hasContext).toBe(false)
    expect(h.loadAiConfig).not.toHaveBeenCalled()
  })
})

describe('classifyFirstInboundContext — clear context', () => {
  it('returns hasContext:true for a message that states a concrete request', async () => {
    h.generateOpenAiStructured.mockResolvedValue({
      data: { has_context: true, reason: 'menciona producto y ciudad' },
      usage: { promptTokens: 60, completionTokens: 12, totalTokens: 72 },
    })
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Necesito cotizar una cocina para mi restaurante en Trujillo',
    )
    expect(result).toEqual({ hasContext: true, reason: 'menciona producto y ciudad' })
    expect(h.generateOpenAiStructured).toHaveBeenCalledTimes(1)
    const callArgs = h.generateOpenAiStructured.mock.calls[0][0]
    expect(callArgs.messages).toEqual([
      { role: 'user', content: 'Necesito cotizar una cocina para mi restaurante en Trujillo' },
    ])
    expect(callArgs.timeoutMs).toBe(5000)
    expect(callArgs.toolName).toBe('classify_first_inbound')
  })

  it('logs usage under mode "context_classification", attributed to the conversation', async () => {
    await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Necesito cotizar una cocina industrial',
    )
    expect(h.logAiUsage).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'context_classification',
        provider: 'openai',
        model: 'gpt-test',
      }),
    )
  })

  it('dispatches to Anthropic when the account is configured for it', async () => {
    h.loadAiConfig.mockResolvedValue(config({ provider: 'anthropic', model: 'claude-test' }))
    h.generateAnthropicStructured.mockResolvedValue({
      data: { has_context: true, reason: 'menciona producto' },
      usage: null,
    })
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Necesito cotizar una cocina industrial',
    )
    expect(result.hasContext).toBe(true)
    expect(h.generateAnthropicStructured).toHaveBeenCalledTimes(1)
    expect(h.generateOpenAiStructured).not.toHaveBeenCalled()
  })
})

describe('classifyFirstInboundContext — genuinely generic messages', () => {
  it('returns hasContext:false for a long-but-generic greeting', async () => {
    h.generateOpenAiStructured.mockResolvedValue({
      data: { has_context: false, reason: 'saludo genérico sin información' },
      usage: { promptTokens: 55, completionTokens: 8, totalTokens: 63 },
    })
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Buenas tardes, disculpen la hora, quería hacerles una consulta por favor',
    )
    expect(result).toEqual({ hasContext: false, reason: 'saludo genérico sin información' })
  })
})

describe('classifyFirstInboundContext — ambiguous message', () => {
  it('trusts whatever the model decides for a short, ambiguous message that clears the length threshold', async () => {
    h.generateOpenAiStructured.mockResolvedValue({
      data: { has_context: false, reason: 'ambiguo, no hay producto ni pedido concreto' },
      usage: { promptTokens: 40, completionTokens: 6, totalTokens: 46 },
    })
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'buenas, una consulta',
    )
    expect(result.hasContext).toBe(false)
    expect(h.generateOpenAiStructured).toHaveBeenCalledTimes(1)
  })
})

describe('classifyFirstInboundContext — fail-open', () => {
  it('fails open when there is no AI config for the account', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Necesito cotizar una cocina industrial',
    )
    expect(result.hasContext).toBe(false)
    expect(h.generateOpenAiStructured).not.toHaveBeenCalled()
  })

  it('fails open when loadAiConfig throws (e.g. undecryptable key)', async () => {
    h.loadAiConfig.mockRejectedValue(new Error('decrypt failed'))
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Necesito cotizar una cocina industrial',
    )
    expect(result.hasContext).toBe(false)
  })

  it('fails open on a provider error', async () => {
    h.generateOpenAiStructured.mockRejectedValue(new Error('OpenAI rate limit reached'))
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Necesito cotizar una cocina industrial',
    )
    expect(result.hasContext).toBe(false)
  })

  it('fails open on a provider timeout (5s cap)', async () => {
    h.generateOpenAiStructured.mockRejectedValue(
      Object.assign(new Error('The AI provider took too long to respond.'), {
        name: 'AiError',
        code: 'timeout',
      }),
    )
    const result = await classifyFirstInboundContext(
      fakeDb,
      'acct-1',
      'conv-1',
      'Necesito cotizar una cocina industrial',
    )
    expect(result.hasContext).toBe(false)
  })

  it('never throws — every failure mode resolves, it never rejects', async () => {
    h.generateOpenAiStructured.mockRejectedValue(new Error('boom'))
    await expect(
      classifyFirstInboundContext(fakeDb, 'acct-1', 'conv-1', 'Necesito cotizar una cocina'),
    ).resolves.toBeDefined()
  })
})
