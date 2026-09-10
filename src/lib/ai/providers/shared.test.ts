import { describe, it, expect } from 'vitest'
import { mergeConsecutive } from './shared'

describe('mergeConsecutive', () => {
  it('joins consecutive plain-text turns into one string, as before', () => {
    expect(
      mergeConsecutive([
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ]),
    ).toEqual([{ role: 'user', content: 'first\n\nsecond' }])
  })

  it('does not merge across a role change', () => {
    expect(
      mergeConsecutive([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('merges text + image (same role) into a block array', () => {
    const image = { type: 'image' as const, mimeType: 'image/jpeg', base64: 'ZmFrZQ==' }
    expect(
      mergeConsecutive([
        { role: 'user', content: [image] },
        { role: 'user', content: 'what is this?' },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [image, { type: 'text', text: 'what is this?' }],
      },
    ])
  })

  it('merges two consecutive image turns without collapsing them', () => {
    const a = { type: 'image' as const, mimeType: 'image/png', base64: 'YQ==' }
    const b = { type: 'image' as const, mimeType: 'image/png', base64: 'Yg==' }
    expect(
      mergeConsecutive([
        { role: 'user', content: [a] },
        { role: 'user', content: [b] },
      ]),
    ).toEqual([{ role: 'user', content: [a, b] }])
  })
})
