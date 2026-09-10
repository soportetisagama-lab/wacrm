import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

// ============================================================
// The actual I/O routine behind persisting a copy of an inbound
// WhatsApp image into our own Storage, for vision (piece b of the
// image-vision integration). Lives here (a lib/ai/* primitive,
// mirroring inbound-audio.ts's transcribeInboundAudio) rather than in
// the webhook route itself, so the download+upload+persist logic has
// exactly one implementation.
//
// Unlike audio transcription, this has no per-call monetary cost (it's
// storage + bandwidth, not a paid model call) and isn't gated behind
// any ai_configs flag — the webhook calls this unconditionally for
// every inbound photo. Only READING the persisted copy into a model
// request (buildConversationContext, piece b's other half) costs
// anything, and that's gated separately (piece c/d).
//
// Callers own the sticker exclusion: never call this for
// message.type === 'sticker' — stickers must never be uploaded, let
// alone spend vision tokens. This module doesn't re-check that itself
// (no `isSticker` param) so there's exactly one place a sticker could
// slip through, and it's an explicit `if` at the call site, not a
// silent default here.
// ============================================================

export interface InboundImageRef {
  /** Meta's media id (message.image.id). */
  mediaId: string
  /** Meta's reported mime type (message.image.mime_type), e.g.
   *  'image/jpeg' — used only to derive the Storage object's file
   *  extension; the object's actual Content-Type comes from Meta's
   *  download response. */
  mimeType: string
  /** uuid of the `messages` row this inbound landed as — the row
   *  `media_storage_url` gets written back onto after a successful
   *  upload. */
  messageDbId: string
}

const FLOW_MEDIA_BUCKET = 'flow-media'

/** 'image/jpeg' -> 'jpeg'. Unlike audio's mime types (codecs params,
 *  subtypes that don't match their extension), image subtypes already
 *  are the extension — no lookup table needed. */
function extensionForMimeType(mimeType: string): string {
  return mimeType.split('/')[1]?.split(';')[0]?.trim() || 'bin'
}

/**
 * Download an inbound image from Meta and persist our own copy in
 * Supabase Storage (the `flow-media` bucket, reused — already public,
 * already exists, path-namespaced under `inbound/` so it never
 * collides with the flow builder's own `{auth.uid()}/...` uploads).
 * Returns the public Storage URL on success, or null on any failure
 * (swallowed and logged here) — a failed persist just leaves
 * `media_storage_url` null, which `buildConversationContext` already
 * treats as "no image available for this turn", not an error.
 */
export async function persistInboundImage(
  db: SupabaseClient,
  args: { accountId: string; image: InboundImageRef },
): Promise<string | null> {
  const { accountId, image } = args
  try {
    const { data: waConfig, error: waErr } = await db
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', accountId)
      .single()
    if (waErr || !waConfig) {
      console.error(
        `[inbound image] persist skipped for account ${accountId}: whatsapp_config not found.`,
      )
      return null
    }
    const accessToken = decrypt(waConfig.access_token)

    const mediaInfo = await getMediaUrl({ mediaId: image.mediaId, accessToken })
    const { buffer } = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })

    const path = `inbound/${accountId}/${image.messageDbId}.${extensionForMimeType(image.mimeType)}`
    const { error: uploadErr } = await db.storage
      .from(FLOW_MEDIA_BUCKET)
      .upload(path, buffer, { contentType: image.mimeType, upsert: true })
    if (uploadErr) {
      console.error('[inbound image] Storage upload failed:', uploadErr)
      return null
    }

    const { data: publicUrlData } = db.storage.from(FLOW_MEDIA_BUCKET).getPublicUrl(path)

    const { error: updateErr } = await db
      .from('messages')
      .update({ media_storage_url: publicUrlData.publicUrl })
      .eq('id', image.messageDbId)
    if (updateErr) {
      console.error('[inbound image] failed to persist media_storage_url:', updateErr)
    }

    return publicUrlData.publicUrl
  } catch (err) {
    console.error('[inbound image] persist failed:', err)
    return null
  }
}
