import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { transcribeAudio } from './transcribe'

// ============================================================
// Shared by both dispatchInboundToAiReply (lib/ai/auto-reply.ts) and
// the collect_ai reply path (lib/flows/engine.ts) — the actual I/O
// routine behind an inbound-voice-note transcription attempt. Lives
// here (a lib/ai/* primitive both already depend on for loadAiConfig/
// buildConversationContext/logAiUsage) rather than in either caller,
// so the download+transcribe+persist logic — and its error handling —
// has exactly one implementation instead of two to keep in sync.
//
// Callers own the eligibility gate (transcribeAudioEnabled +
// embeddingsApiKey) themselves before calling this — this module
// doesn't know about ai_configs at all, same narrow-scope convention
// as transcribeAudio() itself not knowing where its apiKey came from.
// ============================================================

export interface InboundAudioRef {
  /** Meta's media id (message.audio.id) — used to fetch our own
   *  download URL via getMediaUrl, independent of (and redundant with)
   *  the one parseMessageContent already fetched to build the proxy
   *  `media_url`; that URL is never persisted, so there's nothing to
   *  reuse here. */
  mediaId: string
  /** Meta's reported mime type, passed through to transcribeAudio for
   *  its filename-extension mapping. */
  mimeType: string
  /** uuid of the `messages` row this inbound landed as — the row
   *  `transcript` gets written back onto after a successful Whisper
   *  call. */
  messageDbId: string
}

/**
 * Attempt to transcribe an inbound voice note and persist the result.
 * Returns the trimmed transcript text when there's something usable to
 * hand the model, or `null` when there isn't — covering BOTH failure
 * (download/transcription error, swallowed and logged here) AND a
 * legitimate empty transcription (silence, a too-short clip): neither
 * case is a signal callers need to tell apart, so both collapse to the
 * same `null` → callers fall back to their own fixed "text only" reply.
 *
 * `messages.transcript` is written only when Whisper actually
 * responded — even with empty text, since that's a meaningfully
 * different outcome from "never got that far" (download/API failure,
 * which leaves the column NULL). Nothing is persisted before that
 * point: a download that succeeds but is followed by a transcription
 * failure leaves no trace on the row.
 */
export async function transcribeInboundAudio(
  db: SupabaseClient,
  args: {
    accountId: string
    audio: InboundAudioRef
    embeddingsApiKey: string
  },
): Promise<string | null> {
  const { accountId, audio, embeddingsApiKey } = args
  try {
    const { data: waConfig, error: waErr } = await db
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', accountId)
      .single()
    if (waErr || !waConfig) {
      console.error(
        `[inbound audio] transcription skipped for account ${accountId}: whatsapp_config not found.`,
      )
      return null
    }
    const accessToken = decrypt(waConfig.access_token)

    const mediaInfo = await getMediaUrl({ mediaId: audio.mediaId, accessToken })
    const { buffer } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    const result = await transcribeAudio({
      apiKey: embeddingsApiKey,
      audio: buffer,
      mimeType: audio.mimeType,
    })

    const { error: updateErr } = await db
      .from('messages')
      .update({ transcript: result.text })
      .eq('id', audio.messageDbId)
    if (updateErr) {
      console.error('[inbound audio] failed to persist transcript:', updateErr)
    }

    return result.text.trim() || null
  } catch (err) {
    console.error('[inbound audio] transcription failed:', err)
    return null
  }
}
