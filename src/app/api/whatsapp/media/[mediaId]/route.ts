import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  INBOUND_MEDIA_BUCKET,
  baseMimeType,
  parseInboundMediaRef,
  storeInboundMediaCopy,
} from '@/lib/whatsapp/inbound-media'

// Serves an inbound media file to the inbox. Our own copy first
// (migration 070, lib/whatsapp/inbound-media.ts) — Meta stops serving a
// media id after a while, or once the WhatsApp token / app changes —
// and only then Meta, keeping a copy of whatever Meta still returns so
// the next view no longer depends on it.

interface MediaMessageRow {
  id: string
  content_type: string
  media_storage_url: string | null
  filename: string | null
  is_sticker: boolean | null
}

function fileResponse(body: ArrayBuffer | Uint8Array, contentType: string): Response {
  // Copied into a fresh Uint8Array (plain ArrayBuffer) — Response's
  // BodyInit typing rejects a Buffer's ArrayBufferLike backing.
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
    },
  })
}

/** Our stored copy of this message's file, or null if there's none or
 *  it can't be read (then the caller falls back to Meta). */
async function readStoredCopy(row: MediaMessageRow): Promise<Response | null> {
  const stored = row.media_storage_url
  if (!stored) return null
  try {
    const path = parseInboundMediaRef(stored)
    if (path) {
      const { data, error } = await supabaseAdmin().storage.from(INBOUND_MEDIA_BUCKET).download(path)
      if (error || !data) return null
      return fileResponse(await data.arrayBuffer(), data.type)
    }
    if (/^https?:\/\//.test(stored)) {
      const res = await fetch(stored)
      if (!res.ok) return null
      return fileResponse(await res.arrayBuffer(), res.headers.get('content-type') ?? '')
    }
  } catch (err) {
    console.error('[media] stored copy unreadable, falling back to Meta:', err)
  }
  return null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // The message this file belongs to — through the caller's own RLS,
    // so a stored copy is only ever served to someone who can see the
    // conversation.
    const { data: row } = await supabase
      .from('messages')
      .select('id, content_type, media_storage_url, filename, is_sticker')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      .limit(1)
      .maybeSingle<MediaMessageRow>()

    if (row) {
      const stored = await readStoredCopy(row)
      if (stored) return stored
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    let buffer: Buffer
    let contentType: string
    try {
      const mediaInfo = await getMediaUrl({ mediaId, accessToken })
      const downloaded = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })
      buffer = downloaded.buffer
      contentType = downloaded.contentType || mediaInfo.mimeType
    } catch (err) {
      // Expected for old media: Meta no longer serves the id and we
      // have no copy (it predates migration 070). One line, not a
      // stack trace per view.
      console.warn(
        `[media] ${mediaId} no longer available from Meta and no stored copy:`,
        err instanceof Error ? err.message.slice(0, 160) : err,
      )
      return NextResponse.json({ error: 'Media no longer available' }, { status: 404 })
    }

    // Meta still had it — keep our copy so the next view doesn't need Meta.
    if (row && !row.media_storage_url) {
      await storeInboundMediaCopy(supabaseAdmin(), {
        accountId,
        messageDbId: row.id,
        buffer,
        mimeType: baseMimeType(contentType),
        filename: row.filename,
        isPhoto: row.content_type === 'image' && !row.is_sticker,
      })
    }

    return fileResponse(buffer, contentType || 'application/octet-stream')
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
