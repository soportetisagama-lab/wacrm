import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AI_PAUSE_MS,
  assertAiKeyAvailable,
  isAiKeyPaused,
  noteAiKeyFailure,
  resetAiAvailability,
  resumeAiKey,
} from './availability'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import { AiError } from './types'

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}
function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

const ARGS = {
  apiKey: 'sk-avail',
  model: 'gpt-4o-mini',
  systemPrompt: 'x',
  messages: [{ role: 'user' as const, content: 'hola' }],
  timeoutMs: 1000,
}

beforeEach(() => {
  resetAiAvailability()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('availability circuit breaker', () => {
  it('pauses only on out-of-service errors, not on transient ones', () => {
    noteAiKeyFailure('k', new AiError('slow', { code: 'timeout' }))
    noteAiKeyFailure('k', new AiError('busy', { code: 'rate_limited' }))
    expect(isAiKeyPaused('k')).toBe(false)
    noteAiKeyFailure('k', new AiError('no credit', { code: 'no_credit' }))
    expect(isAiKeyPaused('k')).toBe(true)
  })

  it('a rejected key pauses too', () => {
    noteAiKeyFailure('k', new AiError('bad key', { code: 'invalid_key' }))
    expect(() => assertAiKeyAvailable('k')).toThrow(expect.objectContaining({ code: 'no_credit' }))
  })

  it('lets the next call through once the pause expires — AI comes back on its own', () => {
    const t0 = 1_000_000
    noteAiKeyFailure('k', new AiError('no credit', { code: 'no_credit' }), t0)
    expect(isAiKeyPaused('k', t0 + AI_PAUSE_MS - 1)).toBe(true)
    expect(() => assertAiKeyAvailable('k', t0 + AI_PAUSE_MS)).not.toThrow()
    expect(isAiKeyPaused('k', t0 + AI_PAUSE_MS)).toBe(false)
  })

  it('resumeAiKey clears the pause right away', () => {
    noteAiKeyFailure('k', new AiError('no credit', { code: 'no_credit' }))
    resumeAiKey('k')
    expect(isAiKeyPaused('k')).toBe(false)
  })

  it('is per key — another account keeps working', () => {
    noteAiKeyFailure('k1', new AiError('no credit', { code: 'no_credit' }))
    expect(isAiKeyPaused('k2')).toBe(false)
  })
})

describe('providers + breaker', () => {
  it('OpenAI 429 insufficient_quota maps to no_credit and pauses the key; the next call fails fast without fetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errResponse(429, {
        error: {
          message: 'You exceeded your current quota, please check your plan and billing details.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAi(ARGS)).rejects.toMatchObject({ code: 'no_credit' })
    expect(isAiKeyPaused('sk-avail')).toBe(true)

    await expect(generateOpenAi(ARGS)).rejects.toMatchObject({ code: 'no_credit' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a plain OpenAI 429 rate limit stays rate_limited and does not pause', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }),
      ),
    )
    await expect(generateOpenAi(ARGS)).rejects.toMatchObject({ code: 'rate_limited' })
    expect(isAiKeyPaused('sk-avail')).toBe(false)
  })

  it('Anthropic "credit balance is too low" maps to no_credit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Your credit balance is too low to access the Anthropic API.',
          },
        }),
      ),
    )
    await expect(
      generateAnthropic({ ...ARGS, model: 'claude-haiku-4-5-20251001' }),
    ).rejects.toMatchObject({ code: 'no_credit' })
    expect(isAiKeyPaused('sk-avail')).toBe(true)
  })

  it('a successful call clears an expired-then-retried pause', async () => {
    const t0 = Date.now() - AI_PAUSE_MS - 1
    noteAiKeyFailure('sk-avail', new AiError('no credit', { code: 'no_credit' }), t0)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: 'Hola' } }] })),
    )
    await expect(generateOpenAi(ARGS)).resolves.toMatchObject({ text: 'Hola' })
    expect(isAiKeyPaused('sk-avail')).toBe(false)
  })
})
