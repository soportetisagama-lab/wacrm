import type { ContentBlock } from './types'

// ============================================================
// Reads our OWN persisted copy of an inbound image (Supabase Storage,
// written once by `persistInboundImage` — lib/ai/inbound-image.ts) and
// turns it into a `ContentBlock` ready for `ChatMessage.content`. A
// plain unauthenticated fetch — the URL is our own public Storage
// link, not Meta's, so this module never touches WhatsApp credentials.
//
// mimeType comes from the response's own Content-Type header rather
// than a persisted column (normalized, or sniffed from the bytes, so it
// is always a format both providers accept — see normalizeImageMimeType).
// ============================================================

/** The image formats BOTH providers accept (OpenAI and Anthropic).
 *  Anything else (e.g. `application/octet-stream` from a missing
 *  Content-Type) makes Anthropic reject the WHOLE request — so the
 *  type is normalized, sniffed from the bytes when the header doesn't
 *  say, and the image dropped when it's none of these. */
const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** Anthropic's per-image cap is 5 MB; WhatsApp photos are well under. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function sniffMimeType(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (b.length >= 6 && b.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** 'image/JPG; charset=binary' → 'image/jpeg'; null when unsupported. */
export function normalizeImageMimeType(header: string | null, bytes: Buffer): string | null {
  const base = (header ?? '').split(';')[0].trim().toLowerCase()
  const mime = base === 'image/jpg' || base === 'image/pjpeg' ? 'image/jpeg' : base
  if (SUPPORTED_MIME_TYPES.has(mime)) return mime
  return sniffMimeType(bytes)
}

/**
 * Fetch + base64-encode one persisted image. Returns null on any
 * failure (network error, non-2xx, unsupported format, too large)
 * rather than throwing — a single unreachable image should degrade
 * the conversation turn, never fail the whole context build.
 */
export async function fetchImageBlock(url: string): Promise<ContentBlock | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null
    const mimeType = normalizeImageMimeType(res.headers.get('content-type'), buffer)
    if (!mimeType) return null
    return { type: 'image', mimeType, base64: buffer.toString('base64') }
  } catch {
    return null
  }
}
