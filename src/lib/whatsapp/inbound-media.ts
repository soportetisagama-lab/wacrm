import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

// ============================================================
// Our own copy of inbound customer media (migration 070), so the inbox
// never depends on Meta still serving a media id.
//
// Where the copy lives depends on what reads it:
//   * real photos → the public `flow-media` bucket, as a public URL —
//     the same place persistInboundImage (lib/ai/inbound-image.ts)
//     writes, because AI vision fetches `media_storage_url` directly;
//   * everything else (audio, video, documents, stickers) → the
//     private `inbound-media` bucket, recorded as a
//     `storage://inbound-media/<path>` ref that only the media route
//     (service role, after an RLS-scoped message lookup) resolves.
// ============================================================

export const INBOUND_MEDIA_BUCKET = 'inbound-media'
const PUBLIC_IMAGE_BUCKET = 'flow-media'
const STORAGE_REF_PREFIX = `storage://${INBOUND_MEDIA_BUCKET}/`

/** Path inside the private bucket, or null when `value` isn't one of
 *  our refs (e.g. a public http URL, or nothing). */
export function parseInboundMediaRef(value: string | null | undefined): string | null {
  return value?.startsWith(STORAGE_REF_PREFIX) ? value.slice(STORAGE_REF_PREFIX.length) : null
}

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
}

/** Bare mime type — 'audio/ogg; codecs=opus' → 'audio/ogg'. */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase()
}

/** A document's own extension wins ("cotizacion.xlsx"); otherwise the
 *  mime type's; 'bin' when neither says. */
export function extensionFor(mimeType: string, filename?: string | null): string {
  const fromName = filename?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]
  if (fromName) return fromName.toLowerCase()
  return EXTENSIONS[baseMimeType(mimeType)] ?? 'bin'
}

export interface InboundMediaCopyArgs {
  accountId: string
  /** `messages.id` the copy belongs to (also its file name). */
  messageDbId: string
  buffer: Buffer | Uint8Array
  mimeType: string
  filename?: string | null
  /** A real photo (not a sticker) — goes to the public bucket AI
   *  vision reads from. */
  isPhoto: boolean
}

/**
 * Upload `buffer` as this message's copy and record it on
 * `messages.media_storage_url`. Returns the stored value (public URL
 * or storage ref), or null on any failure — logged, never thrown: a
 * missing copy just means the route keeps asking Meta.
 */
export async function storeInboundMediaCopy(
  db: SupabaseClient,
  args: InboundMediaCopyArgs,
): Promise<string | null> {
  try {
    const bucket = args.isPhoto ? PUBLIC_IMAGE_BUCKET : INBOUND_MEDIA_BUCKET
    const path = args.isPhoto
      ? `inbound/${args.accountId}/${args.messageDbId}.${extensionFor(args.mimeType)}`
      : `${args.accountId}/${args.messageDbId}.${extensionFor(args.mimeType, args.filename)}`
    const { error: uploadErr } = await db.storage
      .from(bucket)
      .upload(path, args.buffer, { contentType: baseMimeType(args.mimeType), upsert: true })
    if (uploadErr) {
      console.error(`[inbound media] upload to ${bucket} failed:`, uploadErr.message)
      return null
    }

    const stored = args.isPhoto
      ? db.storage.from(bucket).getPublicUrl(path).data.publicUrl
      : `${STORAGE_REF_PREFIX}${path}`
    const { error: updateErr } = await db
      .from('messages')
      .update({ media_storage_url: stored })
      .eq('id', args.messageDbId)
    if (updateErr) {
      console.error('[inbound media] failed to record media_storage_url:', updateErr.message)
      return null
    }
    return stored
  } catch (err) {
    console.error('[inbound media] copy failed:', err)
    return null
  }
}

/**
 * Webhook path: download a just-received audio / video / document
 * from Meta and keep our copy. Photos go through persistInboundImage
 * instead (it predates this and also feeds AI vision).
 */
export async function persistInboundMedia(
  db: SupabaseClient,
  args: {
    accountId: string
    messageDbId: string
    mediaId: string
    mimeType: string
    filename?: string | null
  },
): Promise<string | null> {
  try {
    const { data: waConfig, error: waErr } = await db
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', args.accountId)
      .single()
    if (waErr || !waConfig) {
      console.error(`[inbound media] skipped for account ${args.accountId}: whatsapp_config not found.`)
      return null
    }
    const accessToken = decrypt(waConfig.access_token)
    const mediaInfo = await getMediaUrl({ mediaId: args.mediaId, accessToken })
    const { buffer } = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })
    return storeInboundMediaCopy(db, {
      accountId: args.accountId,
      messageDbId: args.messageDbId,
      buffer,
      mimeType: args.mimeType || mediaInfo.mimeType,
      filename: args.filename,
      isPhoto: false,
    })
  } catch (err) {
    console.error('[inbound media] persist failed:', err instanceof Error ? err.message : err)
    return null
  }
}
