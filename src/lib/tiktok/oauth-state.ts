// ============================================================
// OAuth `state` for "Conectar con TikTok" (CSRF protection).
//
// /api/tiktok/connect signs `<accountId>.<userId>.<nonce>.<exp>` with the
// app secret and also drops the nonce in an httpOnly cookie; the callback
// accepts the code only when the signature is valid, it hasn't expired,
// the nonce matches the cookie and the signed-in admin is the same one.
// Pure (no I/O) so it's unit-testable.
// ============================================================

import crypto from 'node:crypto'

export const TIKTOK_STATE_COOKIE = 'tiktok_oauth_state'
export const TIKTOK_STATE_TTL_S = 10 * 60

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createOAuthState(args: {
  accountId: string
  userId: string
  secret: string
  nowMs?: number
}): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString('base64url')
  const exp = Math.floor((args.nowMs ?? Date.now()) / 1000) + TIKTOK_STATE_TTL_S
  const payload = `${args.accountId}.${args.userId}.${nonce}.${exp}`
  return { state: `${payload}.${sign(payload, args.secret)}`, nonce }
}

export function verifyOAuthState(args: {
  state: string | null
  cookieNonce: string | null | undefined
  accountId: string
  userId: string
  secret: string
  nowMs?: number
}): boolean {
  if (!args.state || !args.cookieNonce) return false
  const parts = args.state.split('.')
  if (parts.length !== 5) return false
  const [accountId, userId, nonce, exp, mac] = parts
  const expected = sign(`${accountId}.${userId}.${nonce}.${exp}`, args.secret)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  if (accountId !== args.accountId || userId !== args.userId) return false
  if (nonce !== args.cookieNonce) return false
  const nowS = Math.floor((args.nowMs ?? Date.now()) / 1000)
  return /^\d+$/.test(exp) && Number(exp) >= nowS
}
