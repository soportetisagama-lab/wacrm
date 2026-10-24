import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callOpenAiJson, DEFAULT_JUDGE_MODEL, resolveLearningOpenAi } from './openai-judge'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

const BASE = {
  apiKey: 'sk-judge-test',
  model: 'gpt-5.4-mini',
  system: 'sys',
  user: 'usr',
  schemaName: 'verdict',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('resolveLearningOpenAi', () => {
  it('uses the chat key on an OpenAI account', () => {
    expect(
      resolveLearningOpenAi({ provider: 'openai', apiKey: 'sk-a', embeddingsApiKey: 'sk-e' }),
    ).toEqual({ apiKey: 'sk-a', model: DEFAULT_JUDGE_MODEL })
  })
  it('uses the embeddings key on an Anthropic account', () => {
    expect(
      resolveLearningOpenAi({ provider: 'anthropic', apiKey: 'ant', embeddingsApiKey: 'sk-e' })?.apiKey,
    ).toBe('sk-e')
  })
  it('is off without any OpenAI key', () => {
    expect(resolveLearningOpenAi({ provider: 'anthropic', apiKey: 'ant', embeddingsApiKey: null })).toBeNull()
  })
  it('reads the model from AI_JUDGE_MODEL', () => {
    vi.stubEnv('AI_JUDGE_MODEL', 'gpt-x')
    expect(resolveLearningOpenAi({ provider: 'openai', apiKey: 'k', embeddingsApiKey: null })?.model).toBe('gpt-x')
  })
})

describe('callOpenAiJson', () => {
  it('sends a strict json_schema and parses the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = await callOpenAiJson(BASE)
    expect(r.data).toEqual({ ok: true })
    expect(r.usage?.totalTokens).toBe(12)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(body.reasoning_effort).toBe('low')
  })

  it('throws on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: 'nope' } }] })))
    await expect(callOpenAiJson({ ...BASE, apiKey: 'sk-judge-2' })).rejects.toMatchObject({ code: 'invalid_extraction' })
  })

  it('throws on a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: null, refusal: 'no' } }] })),
    )
    await expect(callOpenAiJson({ ...BASE, apiKey: 'sk-judge-3' })).rejects.toMatchObject({ code: 'empty_response' })
  })
})
