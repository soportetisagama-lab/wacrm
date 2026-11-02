// ============================================================
// Inbound TikTok DMs: parse the delivery (./parse) and hand each event
// to the shared social pipeline (lib/social/inbound.ts →
// processSocialEvent): account by (channel 'tiktok', business id),
// dedupe by message id, contact + conversation, message, Flows,
// automations and the AI auto-reply (OpenAI only, never prices — the
// same guards as every other channel). Nothing TikTok-specific past here.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { processSocialEvent } from '@/lib/social/inbound'
import { parseTikTokWebhook } from './parse'

export async function processTikTokWebhookBody(body: unknown): Promise<void> {
  for (const event of parseTikTokWebhook(body)) {
    try {
      await processSocialEvent(supabaseAdmin(), event)
    } catch (err) {
      console.error(`[tiktok webhook] event ${event.mid} failed:`, err)
    }
  }
}
