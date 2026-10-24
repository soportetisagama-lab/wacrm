import { NextResponse, after } from 'next/server'

import { sameSecret, verifyHubSignature } from '@/lib/whatsapp/webhook-signature'
import { processSocialWebhookBody } from '@/lib/social/inbound'
import { channelForObject } from '@/lib/social/parse'

// Instagram (object "instagram") and Messenger (object "page") webhook.
// Configure this URL in the Meta app for both products, with the verify
// token in META_SOCIAL_VERIFY_TOKEN. Payloads are signed with the app
// secret: META_SOCIAL_APP_SECRET, or META_APP_SECRET when Instagram /
// Messenger live in the same Meta app as WhatsApp.

export const maxDuration = 60

function appSecret(): string | undefined {
  return process.env.META_SOCIAL_APP_SECRET || process.env.META_APP_SECRET || undefined
}

// GET - Webhook verification (hub.challenge handshake)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const token = searchParams.get('hub.verify_token')

  if (mode !== 'subscribe' || !challenge || !token) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }
  const expected = process.env.META_SOCIAL_VERIFY_TOKEN
  if (!expected) {
    console.error('[social webhook] META_SOCIAL_VERIFY_TOKEN is not set — verification refused')
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
  }
  if (!sameSecret(token, expected)) {
    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  }
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// POST - Receive Instagram / Messenger events
export async function POST(request: Request) {
  // Raw bytes first: the HMAC is over exactly what Meta sent.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  const secret = appSecret()
  if (!secret) {
    console.error('[social webhook] META_SOCIAL_APP_SECRET / META_APP_SECRET not set — rejecting')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!verifyHubSignature(rawBody, signature, secret)) {
    console.warn('[social webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Anything that isn't Instagram/Messenger is acknowledged and ignored.
  if (!channelForObject((body as { object?: unknown } | null)?.object)) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // Ack fast (Meta retries slow acks → duplicates), finish the work in
  // `after()` so the runtime keeps the function alive until it's done —
  // same reasoning as the WhatsApp webhook.
  after(async () => {
    try {
      await processSocialWebhookBody(body)
    } catch (error) {
      console.error('[social webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
