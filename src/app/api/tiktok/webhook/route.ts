import { NextResponse, after } from 'next/server'

import { TIKTOK_SIGNATURE_HEADER, tiktokEnv, verifyTikTokSignature } from '@/lib/tiktok/api'
import { processTikTokWebhookBody } from '@/lib/tiktok/inbound'
import { summarizeTikTokWebhook } from '@/lib/tiktok/parse'

// TikTok Business Messaging webhook (DMs of the TikTok Business account).
// Register this URL in the TikTok for Business Developers portal.
// Payloads are signed with the app secret (TIKTOK_APP_SECRET).
//
// While TikTok isn't configured (TIKTOK_APP_ID / TIKTOK_APP_SECRET unset)
// every request is answered 200 and ignored: nothing breaks and TikTok
// doesn't keep retrying.

export const maxDuration = 60

// GET - URL check. TODO verificar con docs cuando la app esté aprobada:
// si el portal hace un handshake con `challenge`, se devuelve tal cual.
export async function GET(request: Request) {
  const challenge = new URL(request.url).searchParams.get('challenge')
  if (challenge && tiktokEnv()) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

// POST - Receive TikTok events
export async function POST(request: Request) {
  const env = tiktokEnv()
  if (!env) return NextResponse.json({ status: 'ignored' }, { status: 200 })

  // Raw bytes first: the HMAC is over exactly what TikTok sent.
  const rawBody = await request.text()
  if (!verifyTikTokSignature(rawBody, request.headers.get(TIKTOK_SIGNATURE_HEADER), env.appSecret)) {
    console.warn('[tiktok webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Diagnostic: event and type only — no content, no ids.
  console.log(`[tiktok-webhook] ${summarizeTikTokWebhook(body)}`)

  // Ack fast, finish in `after()` — same reasoning as the Meta webhooks.
  after(async () => {
    try {
      await processTikTokWebhookBody(body)
    } catch (error) {
      console.error('[tiktok webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
