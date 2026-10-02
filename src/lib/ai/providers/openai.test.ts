import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateOpenAi, generateOpenAiStructured } from './openai'
import type { ContentBlock } from '../types'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

const IMAGE: ContentBlock = { type: 'image', mimeType: 'image/jpeg', base64: 'ZmFrZQ==' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('generateOpenAi — image content', () => {
  it('sends an image block as a data: URI image_url part, alongside the caption', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'A cat.' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateOpenAi({
      apiKey: 'sk-test',
      model: 'gpt-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [IMAGE, { type: 'text', text: 'what is this?' }] }],
      timeoutMs: 5000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==' } },
        { type: 'text', text: 'what is this?' },
      ],
    })
  })

  it('still sends plain-string content unwrapped when there is no image', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'Sure.' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateOpenAi({
      apiKey: 'sk-test',
      model: 'gpt-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 5000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('asks reasoning models for low effort so the reply is not starved of tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'Sure.' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateOpenAi({
      apiKey: 'sk-test',
      model: 'gpt-5.4-mini',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 5000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.reasoning_effort).toBe('low')
  })
})

describe('generateOpenAiStructured — reasoning effort', () => {
  async function bodyFor(model: string) {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { tool_calls: [{ function: { name: 'submit', arguments: '{}' } }] } }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAiStructured({
      apiKey: 'sk-test',
      model,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hola' }],
      timeoutMs: 5000,
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      toolName: 'submit',
    }).catch(() => {})
    return JSON.parse(fetchMock.mock.calls[0][1].body)
  }

  it("sends 'none' on gpt-5.x — function tools reject any other effort there", async () => {
    expect((await bodyFor('gpt-5.4-mini')).reasoning_effort).toBe('none')
  })

  it('omits the param for models that do not support none', async () => {
    expect((await bodyFor('gpt-5-mini')).reasoning_effort).toBeUndefined()
    expect((await bodyFor('o4-mini')).reasoning_effort).toBeUndefined()
    expect((await bodyFor('gpt-4o-mini')).reasoning_effort).toBeUndefined()
  })
})

describe('generateOpenAiStructured — image content', () => {
  it('maps image blocks the same way as the free-text path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateOpenAiStructured({
      apiKey: 'sk-test',
      model: 'gpt-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [IMAGE] }],
      timeoutMs: 5000,
      schema: { type: 'object', properties: {}, additionalProperties: false },
      toolName: 'extract',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==' } }],
    })
  })
})
