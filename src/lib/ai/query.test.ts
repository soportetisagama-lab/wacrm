import { describe, it, expect } from 'vitest'
import { latestUserMessage } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })

  it('extracts the text block from an image+caption user turn', () => {
    expect(
      latestUserMessage([
        {
          role: 'user',
          content: [
            { type: 'image', mimeType: 'image/jpeg', base64: 'ZmFrZQ==' },
            { type: 'text', text: 'is this covered under warranty?' },
          ],
        },
      ]),
    ).toBe('is this covered under warranty?')
  })

  it('returns empty string for an image-only user turn (no caption)', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', base64: 'ZmFrZQ==' }] },
      ]),
    ).toBe('')
  })
})
