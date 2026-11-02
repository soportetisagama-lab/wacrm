import { NextResponse, type NextRequest } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { getBaseUrl } from '@/lib/http/base-url'
import { encrypt } from '@/lib/whatsapp/encryption'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { exchangeAuthCode, fetchBusinessProfile, tiktokEnv, tiktokRedirectUri } from '@/lib/tiktok/api'
import { TIKTOK_STATE_COOKIE, verifyOAuthState } from '@/lib/tiktok/oauth-state'

// OAuth callback of "Conectar con TikTok". Registered in the TikTok portal
// as the redirect URL: https://<host>/api/tiktok/callback.
// Owner/admin only (and the RLS of social_channel_configs, migration 080).
// The tokens are stored encrypted and never returned to the browser.
// Always ends with a redirect to Settings → Redes sociales, with
// ?tiktok=<result> for the card to show.

export async function GET(request: NextRequest) {
  const base = getBaseUrl(request)
  const back = (result: string) => {
    const res = NextResponse.redirect(`${base}/settings?tab=social&tiktok=${result}`)
    res.cookies.set(TIKTOK_STATE_COOKIE, '', { path: '/api/tiktok', maxAge: 0 })
    return res
  }

  const env = tiktokEnv()
  if (!env) return back('not_configured')

  let ctx
  try {
    ctx = await requireRole('admin')
  } catch {
    return back('forbidden')
  }

  const params = request.nextUrl.searchParams
  // TODO verificar con docs cuando la app esté aprobada: nombre del parámetro
  // del código (code / auth_code).
  const code = params.get('code') ?? params.get('auth_code')
  if (params.get('error') || !code) return back('denied')
  const stateOk = verifyOAuthState({
    state: params.get('state'),
    cookieNonce: request.cookies.get(TIKTOK_STATE_COOKIE)?.value,
    accountId: ctx.accountId,
    userId: ctx.userId,
    secret: env.appSecret,
  })
  if (!stateOk) return back('state')

  let tokens
  try {
    tokens = await exchangeAuthCode({ env, code, redirectUri: tiktokRedirectUri(base) })
  } catch (err) {
    console.error('[tiktok callback] token exchange failed:', err instanceof Error ? err.message : err)
    return back('token')
  }
  const profile = await fetchBusinessProfile({ accessToken: tokens.accessToken, businessId: tokens.openId })

  const { data: existing } = await ctx.supabase
    .from('social_channel_configs')
    .select('show_to_agents')
    .eq('account_id', ctx.accountId)
    .eq('channel', 'tiktok')
    .maybeSingle()

  const { error } = await ctx.supabase.from('social_channel_configs').upsert(
    {
      account_id: ctx.accountId,
      user_id: ctx.userId,
      channel: 'tiktok',
      external_id: tokens.openId,
      // NOT NULL since 080 (the Facebook page there); for TikTok, the same business id.
      page_id: tokens.openId,
      access_token: encrypt(tokens.accessToken),
      refresh_token: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      token_expires_at: tokens.expiresAt?.toISOString() ?? null,
      refresh_token_expires_at: tokens.refreshExpiresAt?.toISOString() ?? null,
      display_name: profile?.displayName ?? null,
      username: profile?.username ?? null,
      enabled: true,
      show_to_agents: (existing as { show_to_agents?: boolean } | null)?.show_to_agents ?? false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id,channel' },
  )
  if (error) {
    if (isUniqueViolation(error)) return back('taken')
    console.error('[tiktok callback] save failed:', error.message)
    // Most likely migration 087 (refresh_token columns) hasn't run yet.
    return back('save')
  }
  return back('connected')
}
