import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchImageBlock } from './image-block'

function okImageResponse(mimeType: string, bytes: Uint8Array): Response {
  return {
    ok: true,
    headers: { get: (name: string) => (name === 'content-type' ? mimeType : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchImageBlock', () => {
  it('base64-encodes the bytes and reads the mime type off Content-Type', async () => {
    const bytes = new Uint8Array([0x66, 0x61, 0x6b, 0x65]) // "fake"
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okImageResponse('image/jpeg', bytes)),
    )

    expect(await fetchImageBlock('https://storage.example/img.jpg')).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      base64: Buffer.from(bytes).toString('base64'),
    })
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false } as unknown as Response),
    )
    expect(await fetchImageBlock('https://storage.example/missing.jpg')).toBeNull()
  })

  it('returns null when the fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await fetchImageBlock('https://storage.example/img.jpg')).toBeNull()
  })
})
