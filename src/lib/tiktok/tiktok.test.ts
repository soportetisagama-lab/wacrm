import crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAuthorizeUrl, tiktokEnv, tiktokRedirectUri, verifyTikTokSignature } from './api'
import { createOAuthState, verifyOAuthState } from './oauth-state'
import { parseTikTokWebhook } from './parse'
import { tiktokTextsFor } from './send'

const ENV_KEYS = ['TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'TIKTOK_REDIRECT_URI', 'TIKTOK_SCOPES'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('tiktokEnv', () => {
  it('is null (channel off) unless both app id and secret are set', () => {
    delete process.env.TIKTOK_APP_ID
    delete process.env.TIKTOK_APP_SECRET
    expect(tiktokEnv()).toBeNull()
    process.env.TIKTOK_APP_ID = 'app'
    expect(tiktokEnv()).toBeNull()
    process.env.TIKTOK_APP_SECRET = 'secret'
    expect(tiktokEnv()).toEqual({ appId: 'app', appSecret: 'secret' })
  })
})

describe('OAuth URLs', () => {
  it('uses /api/tiktok/callback on this host unless overridden', () => {
    delete process.env.TIKTOK_REDIRECT_URI
    expect(tiktokRedirectUri('https://xlr9-xlr9.ewrx7u.easypanel.host/')).toBe(
      'https://xlr9-xlr9.ewrx7u.easypanel.host/api/tiktok/callback',
    )
    process.env.TIKTOK_REDIRECT_URI = 'https://other.example/cb'
    expect(tiktokRedirectUri('https://x')).toBe('https://other.example/cb')
  })

  it('puts app id, redirect, state and scopes in the authorize URL', () => {
    process.env.TIKTOK_SCOPES = 'a, b'
    const url = new URL(buildAuthorizeUrl({ appId: 'app', redirectUri: 'https://h/api/tiktok/callback', state: 's1' }))
    expect(url.searchParams.get('client_key')).toBe('app')
    expect(url.searchParams.get('redirect_uri')).toBe('https://h/api/tiktok/callback')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('scope')).toBe('a,b')
  })
})

describe('OAuth state', () => {
  const base = { accountId: 'acc-1', userId: 'user-1', secret: 'sec', nowMs: 1_700_000_000_000 }
  it('accepts its own state with the matching cookie, same admin, in time', () => {
    const { state, nonce } = createOAuthState(base)
    expect(verifyOAuthState({ ...base, state, cookieNonce: nonce })).toBe(true)
  })
  it('rejects a wrong cookie, another admin, a tampered or expired state', () => {
    const { state, nonce } = createOAuthState(base)
    expect(verifyOAuthState({ ...base, state, cookieNonce: 'x' })).toBe(false)
    expect(verifyOAuthState({ ...base, userId: 'user-2', state, cookieNonce: nonce })).toBe(false)
    expect(verifyOAuthState({ ...base, secret: 'other', state, cookieNonce: nonce })).toBe(false)
    expect(verifyOAuthState({ ...base, state: state.replace('acc-1', 'acc-2'), cookieNonce: nonce })).toBe(false)
    expect(verifyOAuthState({ ...base, nowMs: base.nowMs + 11 * 60_000, state, cookieNonce: nonce })).toBe(false)
    expect(verifyOAuthState({ ...base, state: null, cookieNonce: nonce })).toBe(false)
  })
})

describe('verifyTikTokSignature', () => {
  const body = '{"event":"im_receive_msg"}'
  const now = 1_700_000_000_000
  const t = String(now / 1000)
  const sig = crypto.createHmac('sha256', 'sec').update(`${t}.${body}`).digest('hex')
  it('accepts a valid signature', () => {
    expect(verifyTikTokSignature(body, `t=${t},s=${sig}`, 'sec', now)).toBe(true)
  })
  it('fails closed', () => {
    expect(verifyTikTokSignature(body, `t=${t},s=${sig}`, '', now)).toBe(false)
    expect(verifyTikTokSignature(body, null, 'sec', now)).toBe(false)
    expect(verifyTikTokSignature(body + ' ', `t=${t},s=${sig}`, 'sec', now)).toBe(false)
    expect(verifyTikTokSignature(body, `t=${t},s=${sig}`, 'other', now)).toBe(false)
    expect(verifyTikTokSignature(body, `t=${t},s=${sig}`, 'sec', now + 60 * 60_000)).toBe(false)
    expect(verifyTikTokSignature(body, 'garbage', 'sec', now)).toBe(false)
  })
})

describe('parseTikTokWebhook', () => {
  const dm = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    event: 'im_receive_msg',
    create_time: 1_700_000_000,
    user_openid: 'biz-1',
    content: JSON.stringify(content),
    ...extra,
  })

  it('maps a text DM to a social inbound event keyed by conversation', () => {
    const [e] = parseTikTokWebhook(
      dm({
        conversation_id: 'conv-9',
        message_id: 'm-1',
        timestamp: 1_700_000_001_000,
        type: 'text',
        text: { body: 'Hola' },
        from_user: { id: 'user-7', role: 'personal_account' },
      }),
    )
    expect(e).toMatchObject({
      channel: 'tiktok',
      externalId: 'biz-1',
      senderId: 'conv-9',
      mid: 'm-1',
      timestamp: 1_700_000_001_000,
      kind: 'message',
      text: 'Hola',
      attachments: [],
      unsupported: false,
    })
  })

  it('ignores our own echoed messages, other events and junk', () => {
    expect(
      parseTikTokWebhook(
        dm({ conversation_id: 'c', message_id: 'm', type: 'text', text: { body: 'x' }, from_user: { id: 'biz-1' } }),
      ),
    ).toEqual([])
    expect(parseTikTokWebhook(dm({ conversation_id: 'c', message_id: 'm' }, { event: 'authorization.removed' }))).toEqual([])
    expect(parseTikTokWebhook(null)).toEqual([])
    expect(parseTikTokWebhook({ event: 'im_receive_msg', content: 'not json' })).toEqual([])
  })

  it('flags media it cannot read as unsupported', () => {
    const [e] = parseTikTokWebhook(dm({ conversation_id: 'c', message_id: 'm', type: 'sticker' }))
    expect(e.unsupported).toBe(true)
    expect(e.text).toBeNull()
  })
})

describe('tiktokTextsFor', () => {
  it('sends menus as numbered text and media as link + caption', () => {
    const [menu] = tiktokTextsFor({
      kind: 'interactive',
      payload: { kind: 'buttons', body: '¿Qué necesitas?', buttons: [{ id: 'a', title: 'Cotizar' }] },
    } as Parameters<typeof tiktokTextsFor>[0])
    expect(menu).toContain('1. Cotizar')
    expect(tiktokTextsFor({ kind: 'media', mediaKind: 'image', url: 'https://x/y.jpg', caption: 'Mira' })).toEqual([
      'Mira\nhttps://x/y.jpg',
    ])
    expect(tiktokTextsFor({ kind: 'text', text: '  ' })).toEqual([])
  })
})
