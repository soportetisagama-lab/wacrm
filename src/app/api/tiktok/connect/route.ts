import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getBaseUrl } from '@/lib/http/base-url'
import { buildAuthorizeUrl, tiktokEnv, tiktokRedirectUri } from '@/lib/tiktok/api'
import { TIKTOK_STATE_COOKIE, TIKTOK_STATE_TTL_S, createOAuthState } from '@/lib/tiktok/oauth-state'

// "Conectar con TikTok" (Settings, owner/admin only): sends the admin to
// TikTok's authorization page. TikTok comes back to /api/tiktok/callback.

export async function GET(request: Request) {
  const base = getBaseUrl(request)
  try {
    const ctx = await requireRole('admin')
    const env = tiktokEnv()
    if (!env) {
      return NextResponse.redirect(`${base}/settings?tab=social&tiktok=not_configured`)
    }
    const { state, nonce } = createOAuthState({
      accountId: ctx.accountId,
      userId: ctx.userId,
      secret: env.appSecret,
    })
    const res = NextResponse.redirect(
      buildAuthorizeUrl({ appId: env.appId, redirectUri: tiktokRedirectUri(base), state }),
    )
    res.cookies.set(TIKTOK_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: base.startsWith('https://'),
      // Lax: the cookie must ride on TikTok's top-level redirect back to us.
      sameSite: 'lax',
      path: '/api/tiktok',
      maxAge: TIKTOK_STATE_TTL_S,
    })
    return res
  } catch (err) {
    return toErrorResponse(err)
  }
}
