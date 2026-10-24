import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scheduled: Array<() => Promise<void>> = []
const processSocialWebhookBody = vi.fn(async (body: unknown) => {
  void body
})

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    after: (fn: () => Promise<void>) => {
      scheduled.push(fn)
    },
  }
})

vi.mock('@/lib/social/inbound', () => ({
  processSocialWebhookBody: (body: unknown) => processSocialWebhookBody(body),
}))

import { GET, POST } from './route'

const SECRET = 'social-secret'
const VERIFY = 'verify-me'

function sign(body: string, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function post(body: string, signature: string | null) {
  return new Request('https://crm.example/api/social/webhook', {
    method: 'POST',
    body,
    headers: signature ? { 'x-hub-signature-256': signature } : {},
  })
}

beforeEach(() => {
  scheduled.length = 0
  process.env.META_SOCIAL_VERIFY_TOKEN = VERIFY
  process.env.META_SOCIAL_APP_SECRET = SECRET
})

afterEach(() => {
  delete process.env.META_SOCIAL_VERIFY_TOKEN
  delete process.env.META_SOCIAL_APP_SECRET
})

describe('GET /api/social/webhook (verification)', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const res = await GET(
      new Request(`https://crm.example/api/social/webhook?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=${VERIFY}`),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('12345')
  })

  it('refuses a wrong token', async () => {
    const res = await GET(
      new Request('https://crm.example/api/social/webhook?hub.mode=subscribe&hub.challenge=1&hub.verify_token=nope'),
    )
    expect(res.status).toBe(403)
  })

  it('refuses when the verify token env var is not set (fail closed)', async () => {
    delete process.env.META_SOCIAL_VERIFY_TOKEN
    const res = await GET(
      new Request(`https://crm.example/api/social/webhook?hub.mode=subscribe&hub.challenge=1&hub.verify_token=${VERIFY}`),
    )
    expect(res.status).toBe(403)
  })

  it('400s without the hub parameters', async () => {
    const res = await GET(new Request('https://crm.example/api/social/webhook'))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/social/webhook', () => {
  const body = JSON.stringify({
    object: 'instagram',
    entry: [{ id: 'IG-1', messaging: [{ sender: { id: 'U1' }, message: { mid: 'm1', text: 'Hola' } }] }],
  })

  it('rejects a missing or wrong X-Hub-Signature-256', async () => {
    expect((await POST(post(body, null))).status).toBe(401)
    expect((await POST(post(body, sign(body, 'other-secret')))).status).toBe(401)
    expect((await POST(post(body + ' ', sign(body)))).status).toBe(401)
    expect(scheduled).toHaveLength(0)
  })

  it('fails closed when no app secret is configured', async () => {
    delete process.env.META_SOCIAL_APP_SECRET
    const prev = process.env.META_APP_SECRET
    delete process.env.META_APP_SECRET
    try {
      expect((await POST(post(body, sign(body)))).status).toBe(401)
    } finally {
      if (prev !== undefined) process.env.META_APP_SECRET = prev
    }
  })

  it('falls back to META_APP_SECRET (same Meta app as WhatsApp)', async () => {
    delete process.env.META_SOCIAL_APP_SECRET
    const res = await POST(post(body, sign(body, process.env.META_APP_SECRET!)))
    expect(res.status).toBe(200)
  })

  it('acks a signed event and processes it after the response', async () => {
    const res = await POST(post(body, sign(body)))
    expect(res.status).toBe(200)
    expect(scheduled).toHaveLength(1)
    await scheduled[0]()
    expect(processSocialWebhookBody).toHaveBeenCalledWith(JSON.parse(body))
  })

  it('acknowledges but ignores objects that are not Instagram/Messenger', async () => {
    const other = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })
    const res = await POST(post(other, sign(other)))
    expect(res.status).toBe(200)
    expect(scheduled).toHaveLength(0)
  })

  it('400s on invalid JSON with a valid signature', async () => {
    const bad = '{not json'
    expect((await POST(post(bad, sign(bad)))).status).toBe(400)
  })

  it('logs one content-free diagnostic line per signed POST', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const sb = JSON.stringify({
        object: 'page',
        entry: [{ id: 'PAGE-1', standby: [{ sender: { id: 'PSID-9' }, message: { mid: 'm9', text: 'Hola secreto' } }] }],
      })
      await POST(post(sb, sign(sb)))
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[social-webhook]'))
      expect(lines).toEqual(['[social-webhook] object=page entries=1 PAGE-1:standby[message]'])
    } finally {
      log.mockRestore()
    }
  })
})
