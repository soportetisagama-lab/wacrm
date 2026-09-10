import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

function okImageResponse(mimeType: string, base64: string): Response {
  // Buffer.from(...).buffer is the pooled underlying ArrayBuffer, which
  // can be larger than the Buffer's own byteLength — copy into a
  // freshly-sized Uint8Array first so its .buffer is exactly the bytes.
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
  return {
    ok: true,
    headers: { get: (name: string) => (name === 'content-type' ? mimeType : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response
}

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().or().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('uses the transcript as content for a transcribed audio message', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_type: 'audio',
          content_text: null,
          transcript: 'quiero cotizar dos cocinas',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'quiero cotizar dos cocinas' }])
  })

  it('drops an audio message whose transcript is an empty string', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_type: 'audio', content_text: null, transcript: '' },
        { sender_type: 'customer', content_type: 'text', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  describe('includeImages', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })
    afterEach(() => vi.unstubAllGlobals())

    it('excludes image rows when includeImages is not passed (default false) — regression guard', async () => {
      const out = await buildConversationContext(
        fakeDb([
          {
            sender_type: 'customer',
            content_type: 'image',
            content_text: 'look at this',
            is_sticker: false,
            media_storage_url: 'https://storage.example/photo.jpg',
          },
        ]),
        'conv-1',
      )
      expect(out).toEqual([])
    })

    it('builds an image + caption block for a real photo with a persisted copy', async () => {
      const base64 = Buffer.from('fake').toString('base64')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okImageResponse('image/jpeg', base64)))

      const out = await buildConversationContext(
        fakeDb([
          {
            sender_type: 'customer',
            content_type: 'image',
            content_text: 'is this covered under warranty?',
            is_sticker: false,
            media_storage_url: 'https://storage.example/photo.jpg',
          },
        ]),
        'conv-1',
        undefined,
        { includeImages: true },
      )
      expect(out).toEqual([
        {
          role: 'user',
          content: [
            { type: 'image', mimeType: 'image/jpeg', base64 },
            { type: 'text', text: 'is this covered under warranty?' },
          ],
        },
      ])
    })

    it('excludes a sticker even with includeImages: true, and never fetches it', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const out = await buildConversationContext(
        fakeDb([
          {
            sender_type: 'customer',
            content_type: 'image',
            content_text: null,
            is_sticker: true,
            // Set on purpose, to prove is_sticker is checked independently
            // of media_storage_url (the second of two defenses).
            media_storage_url: 'https://storage.example/sticker.webp',
          },
        ]),
        'conv-1',
        undefined,
        { includeImages: true },
      )
      expect(out).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('falls back to caption-only when a real photo has no persisted copy yet', async () => {
      const out = await buildConversationContext(
        fakeDb([
          {
            sender_type: 'customer',
            content_type: 'image',
            content_text: 'is this covered under warranty?',
            is_sticker: false,
            media_storage_url: null,
          },
        ]),
        'conv-1',
        undefined,
        { includeImages: true },
      )
      expect(out).toEqual([{ role: 'user', content: 'is this covered under warranty?' }])
    })

    it('drops a real photo with no persisted copy and no caption', async () => {
      const out = await buildConversationContext(
        fakeDb([
          {
            sender_type: 'customer',
            content_type: 'image',
            content_text: null,
            is_sticker: false,
            media_storage_url: null,
          },
        ]),
        'conv-1',
        undefined,
        { includeImages: true },
      )
      expect(out).toEqual([])
    })

    it('falls back to caption-only when the persisted copy fails to fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as unknown as Response))

      const out = await buildConversationContext(
        fakeDb([
          {
            sender_type: 'customer',
            content_type: 'image',
            content_text: 'is this covered under warranty?',
            is_sticker: false,
            media_storage_url: 'https://storage.example/gone.jpg',
          },
        ]),
        'conv-1',
        undefined,
        { includeImages: true },
      )
      expect(out).toEqual([{ role: 'user', content: 'is this covered under warranty?' }])
    })
  })
})
