import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from './transcribe'
import { AiError } from './types'

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

function args(overrides: Partial<Parameters<typeof transcribeAudio>[0]> = {}) {
  return {
    apiKey: 'sk-test',
    audio: Buffer.from('fake-audio-bytes'),
    mimeType: 'audio/ogg; codecs=opus',
    ...overrides,
  }
}

/** Pulls the `file` part's filename back out of the FormData body a
 *  mocked fetch call was given, so tests can assert on the extension
 *  transcribeAudio picked without reaching into fetch internals. */
function sentFilename(fetchMock: ReturnType<typeof vi.fn>): string {
  const body = fetchMock.mock.calls[0][1].body as FormData
  const file = body.get('file') as File
  return file.name
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('transcribeAudio — happy path', () => {
  it('posts multipart with the file, default model, and verbose_json format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ text: 'Hola, quiero cotizar dos cocinas.', duration: 4.2 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await transcribeAudio(args())

    expect(res).toEqual({
      text: 'Hola, quiero cotizar dos cocinas.',
      durationSeconds: 4.2,
    })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
    // fetch sets the multipart boundary itself from the FormData body —
    // we must not set Content-Type by hand.
    expect(opts.headers['Content-Type']).toBeUndefined()

    const body = opts.body as FormData
    expect(body.get('model')).toBe('whisper-1')
    expect(body.get('response_format')).toBe('verbose_json')
    expect(body.get('file')).toBeInstanceOf(File)
  })

  it('uses a custom model when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ text: 'hi' }))
    vi.stubGlobal('fetch', fetchMock)

    await transcribeAudio(args({ model: 'whisper-2-preview' }))

    const body = fetchMock.mock.calls[0][1].body as FormData
    expect(body.get('model')).toBe('whisper-2-preview')
  })

  it('trims the transcript text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ text: '  hola  ' })),
    )
    const res = await transcribeAudio(args())
    expect(res.text).toBe('hola')
  })

  it('returns durationSeconds:null when the API does not report one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ text: 'hi' })))
    const res = await transcribeAudio(args())
    expect(res.durationSeconds).toBeNull()
  })

  it('does not throw on an empty transcription — silence is a valid result, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ text: '' })))
    const res = await transcribeAudio(args())
    expect(res).toEqual({ text: '', durationSeconds: null })
  })
})

describe('transcribeAudio — filename extension by mime type', () => {
  const cases: Array<[string, string]> = [
    ['audio/ogg; codecs=opus', 'audio.ogg'],
    ['audio/ogg', 'audio.ogg'],
    ['audio/opus', 'audio.ogg'],
    ['audio/mpeg', 'audio.mp3'],
    ['audio/mp4', 'audio.m4a'],
    ['audio/wav', 'audio.wav'],
    ['audio/webm', 'audio.webm'],
  ]

  for (const [mimeType, expectedFilename] of cases) {
    it(`maps "${mimeType}" to ${expectedFilename}`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse({ text: 'hi' }))
      vi.stubGlobal('fetch', fetchMock)
      await transcribeAudio(args({ mimeType }))
      expect(sentFilename(fetchMock)).toBe(expectedFilename)
    })
  }

  it('falls back to .ogg (the WhatsApp voice-note default) for an unmapped mime type, rather than failing before even asking Whisper', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ text: 'hi' }))
    vi.stubGlobal('fetch', fetchMock)
    await transcribeAudio(args({ mimeType: 'audio/x-totally-unknown' }))
    expect(sentFilename(fetchMock)).toBe('audio.ogg')
  })
})

describe('transcribeAudio — errors', () => {
  it('maps a 401 to an invalid_key AiError, same shape as a chat-call failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'Incorrect API key' } })),
    )
    await expect(transcribeAudio(args())).rejects.toMatchObject({
      code: 'invalid_key',
      status: 401,
    })
  })

  it('maps a 429 to a rate_limited AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(429, { error: { message: 'Rate limit exceeded' } })),
    )
    await expect(transcribeAudio(args())).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('maps a 400 (corrupt/unsupported audio) to a provider_error AiError carrying OpenAI\'s own explanation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(400, { error: { message: 'Invalid file format' } }),
      ),
    )
    await expect(transcribeAudio(args())).rejects.toMatchObject({
      code: 'provider_error',
    })
    await expect(transcribeAudio(args())).rejects.toBeInstanceOf(AiError)
    await expect(transcribeAudio(args())).rejects.toThrow(/Invalid file format/)
  })

  it('wraps a network failure via toNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(transcribeAudio(args())).rejects.toMatchObject({
      code: 'network_error',
      status: 502,
    })
  })

  it('wraps an aborted (timeout) request distinctly from a generic network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')),
    )
    await expect(transcribeAudio(args())).rejects.toMatchObject({
      code: 'timeout',
      status: 504,
    })
  })
})
