import type { ContentBlock } from './types'

// ============================================================
// Reads our OWN persisted copy of an inbound image (Supabase Storage,
// written once by `persistInboundImage` — lib/ai/inbound-image.ts) and
// turns it into a `ContentBlock` ready for `ChatMessage.content`. A
// plain unauthenticated fetch — the URL is our own public Storage
// link, not Meta's, so this module never touches WhatsApp credentials.
//
// mimeType comes from the response's own Content-Type header rather
// than a persisted column — the object already carries it, so there's
// nothing to duplicate.
// ============================================================

/**
 * Fetch + base64-encode one persisted image. Returns null on any
 * failure (network error, non-2xx) rather than throwing — a single
 * unreachable image should degrade the conversation turn to
 * caption-only (or drop it), never fail the whole context build.
 */
export async function fetchImageBlock(url: string): Promise<ContentBlock | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const mimeType = res.headers.get('content-type') || 'application/octet-stream'
    const buffer = Buffer.from(await res.arrayBuffer())
    return { type: 'image', mimeType, base64: buffer.toString('base64') }
  } catch {
    return null
  }
}
