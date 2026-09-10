import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateAnthropic, generateAnthropicStructured } from './anthropic'
import type { ContentBlock } from '../types'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

const IMAGE: ContentBlock = { type: 'image', mimeType: 'image/png', base64: 'ZmFrZQ==' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('generateAnthropic — image content', () => {
  it('sends an image block as a base64 image source, alongside the caption', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ content: [{ type: 'text', text: 'A cat.' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateAnthropic({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [IMAGE, { type: 'text', text: 'what is this?' }] }],
      timeoutMs: 5000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
        { type: 'text', text: 'what is this?' },
      ],
    })
  })

  it('still sends plain-string content unwrapped when there is no image', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ content: [{ type: 'text', text: 'Sure.' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateAnthropic({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 5000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' })
  })
})

describe('generateAnthropicStructured — image content', () => {
  it('maps image blocks the same way as the free-text path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ content: [{ type: 'tool_use', input: { ok: true } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateAnthropicStructured({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [IMAGE] }],
      timeoutMs: 5000,
      schema: { type: 'object', properties: {} },
      toolName: 'extract',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
      ],
    })
  })
})
