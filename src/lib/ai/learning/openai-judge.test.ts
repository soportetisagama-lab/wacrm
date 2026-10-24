import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callOpenAiJson,
  DEFAULT_JUDGE_MODEL,
  isLearningKeyPaused,
  resetLearningAvailability,
  resolveLearningOpenAi,
} from './openai-judge'
import { isAiKeyPaused, resetAiAvailability } from '../availability'

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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  resetLearningAvailability()
  resetAiAvailability()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('resolveLearningOpenAi', () => {
  it('uses the chat key on an OpenAI account', () => {
    expect(
      resolveLearningOpenAi({ provider: 'openai', apiKey: 'sk-a', embeddingsApiKey: 'sk-e' }),
    ).toEqual({ apiKey: 'sk-a', model: DEFAULT_JUDGE_MODEL, fallbackModel: null })
  })
  it('offers the configured OpenAI chat model as fallback', () => {
    expect(
      resolveLearningOpenAi({ provider: 'openai', apiKey: 'sk-a', embeddingsApiKey: null, model: 'gpt-4.1-mini' })
        ?.fallbackModel,
    ).toBe('gpt-4.1-mini')
    expect(
      resolveLearningOpenAi({ provider: 'anthropic', apiKey: 'a', embeddingsApiKey: 'sk-e', model: 'claude-x' })
        ?.fallbackModel,
    ).toBeNull()
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

function errResponse(status: number, message: string, code = ''): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message, code } }),
  } as unknown as Response
}

describe('callOpenAiJson — never pauses the bot key', () => {
  it('falls back to the configured model when the judge model is not available', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(403, 'Project does not have access to model gpt-5.4-mini', 'model_not_found'))
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: '{"ok":true}' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await callOpenAiJson({ ...BASE, apiKey: 'sk-fb', fallbackModel: 'gpt-4.1-mini' })
    expect(r.model).toBe('gpt-4.1-mini')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('gpt-4.1-mini')
    expect(isAiKeyPaused('sk-fb')).toBe(false)
    // Remembered: the next call goes straight to the fallback.
    fetchMock.mockResolvedValueOnce(okResponse({ choices: [{ message: { content: '{"ok":true}' } }] }))
    await callOpenAiJson({ ...BASE, apiKey: 'sk-fb', fallbackModel: 'gpt-4.1-mini' })
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).model).toBe('gpt-4.1-mini')
  })

  it('a rejected key pauses only the learning jobs, not the bot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401, 'Incorrect API key')))
    await expect(callOpenAiJson({ ...BASE, apiKey: 'sk-bad' })).rejects.toMatchObject({ code: 'invalid_key' })
    expect(isAiKeyPaused('sk-bad')).toBe(false)
    expect(isLearningKeyPaused('sk-bad')).toBe(true)
    await expect(callOpenAiJson({ ...BASE, apiKey: 'sk-bad' })).rejects.toMatchObject({ code: 'learning_paused' })
  })

  it('reports usage even when the answer is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ choices: [{ message: { content: 'nope' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      ),
    )
    const onUsage = vi.fn()
    await expect(callOpenAiJson({ ...BASE, apiKey: 'sk-u', onUsage })).rejects.toBeTruthy()
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 6 }), 'gpt-5.4-mini')
  })
})
