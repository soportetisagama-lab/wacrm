import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration, extractWithReply, parseExtraction } from './generate'
import { AiError, type AiConfig } from './types'
import type { ExtractionField } from './schema'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})

const FIELDS: ExtractionField[] = [
  { key: 'equipos', label: 'Equipos', required: true },
  { key: 'ciudad', label: 'Ciudad', required: true },
  { key: 'rubro', label: 'Rubro del negocio', required: false },
]

describe('parseExtraction', () => {
  it('keeps only non-empty string values for known fields', () => {
    const res = parseExtraction(
      { extracted: { equipos: '2 cocinas', ciudad: null, rubro: '' }, reply_text: '¿En qué ciudad?', done: false, handoff: false },
      FIELDS,
    )
    expect(res).toEqual({
      fields: { equipos: '2 cocinas' },
      replyText: '¿En qué ciudad?',
      done: false,
      handoff: false,
      usage: null,
    })
  })

  it('drops hallucinated keys not in the field list', () => {
    const res = parseExtraction(
      { extracted: { equipos: 'freidora', presupuesto: '5000' }, reply_text: '', done: false, handoff: false },
      FIELDS,
    )
    expect(res.fields).toEqual({ equipos: 'freidora' })
  })

  it('degrades to an empty, non-done, non-handoff result on a malformed payload', () => {
    expect(parseExtraction(null, FIELDS)).toEqual({
      fields: {},
      replyText: '',
      done: false,
      handoff: false,
      usage: null,
    })
    expect(parseExtraction('not an object', FIELDS)).toEqual({
      fields: {},
      replyText: '',
      done: false,
      handoff: false,
      usage: null,
    })
    expect(parseExtraction({ extracted: 'nope' }, FIELDS).fields).toEqual({})
  })

  it('only treats literal booleans as done/handoff (no truthy coercion)', () => {
    const res = parseExtraction(
      { extracted: {}, reply_text: '', done: 'true', handoff: 1 },
      FIELDS,
    )
    expect(res.done).toBe(false)
    expect(res.handoff).toBe(false)
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 12, completionTokens: 4, totalTokens: 16 }
    const res = parseExtraction(
      { extracted: {}, reply_text: 'hi', done: false, handoff: false },
      FIELDS,
      usage,
    )
    expect(res.usage).toEqual(usage)
  })
})

describe('extractWithReply — OpenAI', () => {
  it('forces a tool call and returns the parsed extraction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'submit',
                    arguments: JSON.stringify({
                      extracted: { equipos: '2 cocinas y una freidora', ciudad: 'Trujillo', rubro: null },
                      reply_text: '¿A qué rubro pertenece tu negocio?',
                      done: false,
                      handoff: false,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await extractWithReply({
      config: config({ provider: 'openai' }),
      fields: FIELDS,
      knownValues: {},
      messages: [{ role: 'user', content: 'quiero cotizar 2 cocinas y una freidora en Trujillo' }],
    })

    expect(res).toEqual({
      fields: { equipos: '2 cocinas y una freidora', ciudad: 'Trujillo' },
      replyText: '¿A qué rubro pertenece tu negocio?',
      done: false,
      handoff: false,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    })

    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit' } })
    expect(body.tools[0].function.strict).toBe(true)
    expect(body.tools[0].function.parameters.additionalProperties).toBe(false)
  })

  it('throws when the model replies without a tool call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: {} }] })),
    )
    await expect(
      extractWithReply({
        config: config(),
        fields: FIELDS,
        knownValues: {},
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'empty_response' })
  })

  it('throws on unparseable tool-call arguments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [
            { message: { tool_calls: [{ function: { name: 'submit', arguments: '{not json' } }] } },
          ],
        }),
      ),
    )
    await expect(
      extractWithReply({
        config: config(),
        fields: FIELDS,
        knownValues: {},
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_extraction' })
  })
})

describe('extractWithReply — Anthropic', () => {
  it('forces a tool call and reads the already-parsed input object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [
          {
            type: 'tool_use',
            input: {
              extracted: { equipos: null, ciudad: null, rubro: 'restaurante' },
              reply_text: '¿Qué equipos te interesa cotizar y en qué ciudad?',
              done: false,
              handoff: false,
            },
          },
        ],
        usage: { input_tokens: 80, output_tokens: 15 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await extractWithReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      fields: FIELDS,
      knownValues: {},
      messages: [{ role: 'user', content: 'somos un restaurante' }],
    })

    expect(res).toEqual({
      fields: { rubro: 'restaurante' },
      replyText: '¿Qué equipos te interesa cotizar y en qué ciudad?',
      done: false,
      handoff: false,
      usage: { promptTokens: 80, completionTokens: 15, totalTokens: 95 },
    })

    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit' })
    expect(body.tools[0].name).toBe('submit')
  })

  it('reports done + handoff flags straight through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          content: [
            {
              type: 'tool_use',
              input: {
                extracted: { equipos: '2 cocinas', ciudad: 'Trujillo', rubro: 'restaurante' },
                reply_text: 'Gracias, un asesor te contactará con la cotización.',
                done: true,
                handoff: false,
              },
            },
          ],
        }),
      ),
    )
    const res = await extractWithReply({
      config: config({ provider: 'anthropic' }),
      fields: FIELDS,
      knownValues: { equipos: '2 cocinas', ciudad: 'Trujillo' },
      messages: [{ role: 'user', content: 'somos un restaurante' }],
    })
    expect(res.done).toBe(true)
    expect(res.fields.rubro).toBe('restaurante')
  })

  it('throws when no tool_use block is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'oops' }] })),
    )
    await expect(
      extractWithReply({
        config: config({ provider: 'anthropic' }),
        fields: FIELDS,
        knownValues: {},
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'empty_response' })
  })
})
