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
