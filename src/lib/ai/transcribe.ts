import { aiTranscribeTimeoutMs } from './defaults'
import { toNetworkError, providerHttpError } from './providers/shared'

// ============================================================
// Whisper (OpenAI) audio transcription — standalone, not part of the
// multi-provider chat abstraction (generateReply/ChatMessage). There is
// no Anthropic equivalent to dispatch to, and transcription always uses
// OpenAI/Whisper regardless of the account's chosen CHAT provider, so
// this doesn't live under providers/ or go through generate.ts's
// provider switch — it's its own narrow capability.
//
// Deliberately doesn't know about ai_configs: callers read
// `config.embeddingsApiKey` (the account's auxiliary OpenAI-compatible
// key, already used for semantic search) and pass it in as `apiKey`,
// same narrow-scope convention as `generateOpenAi` not knowing where
// its own apiKey came from.
// ============================================================

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions'
const DEFAULT_MODEL = 'whisper-1'

/** Meta's reported mime type (minus any `; codecs=...` parameter) to a
 *  filename extension — Whisper infers the audio format from the
 *  filename extension on the multipart part, not the Content-Type.
 *  WhatsApp voice notes are `audio/ogg; codecs=opus`; regular audio
 *  file sends can arrive as other formats. NOT validated against
 *  Whisper's actual accepted-format list here — an unsupported format
 *  surfaces as a 400 from the API itself (see providerHttpError below),
 *  with OpenAI's own explanation in the message. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
}

/** Falls back to 'ogg' (the WhatsApp voice-note default) for an
 *  unmapped mime type, rather than failing before ever asking Whisper —
 *  worst case Whisper itself rejects it with a clear format error. */
function extensionForMimeType(mimeType: string): string {
  const bare = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXTENSION_BY_MIME[bare] ?? 'ogg'
}

export interface TranscribeAudioArgs {
  /** OpenAI-compatible API key — the account's auxiliary key
   *  (ai_configs.embeddings_api_key), independent of its main chat
   *  provider/key. This module never reads ai_configs itself. */
  apiKey: string
  /** Raw audio bytes, as returned by downloadMedia (lib/whatsapp/meta-api). */
  audio: Buffer
  /** Meta's reported mime type, e.g. 'audio/ogg; codecs=opus'. */
  mimeType: string
  /** Defaults to 'whisper-1'. Kept as a parameter (not hardcoded)
   *  matching how chat models are configurable, though whisper-1 is the
   *  only sane default today. */
  model?: string
  timeoutMs?: number
}

export interface TranscribeAudioResult {
  text: string
  /**
   * Seconds of audio, from Whisper's `verbose_json` response (the
   * default `json` format doesn't include duration). Null when the API
   * didn't report one. Not used by this piece — carried through for a
   * later `ai_usage_log.audio_seconds`.
   */
  durationSeconds: number | null
}

interface WhisperVerboseJsonResponse {
  text?: string
  duration?: number
}

/**
 * Transcribe one audio file via OpenAI's Whisper endpoint. Requests
 * `response_format: 'verbose_json'` specifically to get `duration`
 * back without having to parse the audio container ourselves.
 *
 * Never throws on a merely EMPTY transcription (silence, a very short
 * clip) — that's a legitimate result, not a failure; callers decide
 * what an empty `text` means for their own flow. Throws `AiError` only
 * for actual request failures: network/timeout (`toNetworkError`) or a
 * non-2xx response — invalid key, rate limit, or a rejected/corrupt/
 * unsupported audio file, all surfaced through the same
 * `providerHttpError` every other provider adapter already uses, so
 * the error `code`/`status`/message shape is identical to a chat-call
 * failure.
 */
export async function transcribeAudio(
  args: TranscribeAudioArgs,
): Promise<TranscribeAudioResult> {
  const { apiKey, audio, mimeType, model = DEFAULT_MODEL } = args
  const timeoutMs = args.timeoutMs ?? aiTranscribeTimeoutMs()

  const form = new FormData()
  const filename = `audio.${extensionForMimeType(mimeType)}`
  // Buffer's ArrayBufferLike backing isn't directly assignable to
  // BlobPart's stricter ArrayBuffer type — same Uint8Array wrap the
  // media proxy route already uses for the same Buffer→web-API-body
  // mismatch (api/whatsapp/media/[mediaId]/route.ts).
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename)
  form.append('model', model)
  form.append('response_format', 'verbose_json')

  let res: Response
  try {
    res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // No Content-Type header: fetch sets the multipart boundary
        // itself from the FormData body.
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI Whisper', res)
  }

  const data = (await res.json().catch(() => null)) as WhisperVerboseJsonResponse | null
  return {
    text: typeof data?.text === 'string' ? data.text.trim() : '',
    durationSeconds: typeof data?.duration === 'number' ? data.duration : null,
  }
}
