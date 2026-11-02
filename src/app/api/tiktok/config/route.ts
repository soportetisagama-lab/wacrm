import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { TIKTOK_CALLBACK_PATH, TIKTOK_WEBHOOK_PATH, tiktokEnv } from '@/lib/tiktok/api'

// TikTok connection status for Settings — owner/admin only (both here and
// in the RLS of social_channel_configs, migration 080). Tokens never leave
// this handler. Connecting is the OAuth flow (/api/tiktok/connect →
// /api/tiktok/callback); here: read, switch on/off, show to agents,
// disconnect.

interface TikTokRow {
  external_id: string
  display_name: string | null
  username: string | null
  enabled: boolean
  show_to_agents: boolean
  updated_at: string
  // Migration 087 (absent until it runs).
  token_expires_at?: string | null
  refresh_token_expires_at?: string | null
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data, error } = await ctx.supabase
      .from('social_channel_configs')
      .select('*')
      .eq('account_id', ctx.accountId)
      .eq('channel', 'tiktok')
      .maybeSingle()
    const row = (data ?? null) as TikTokRow | null
    // Probe for 087 without touching anything: its column must be selectable.
    const { error: probeError } = await ctx.supabase
      .from('social_channel_configs')
      .select('refresh_token_expires_at')
      .limit(0)
    return NextResponse.json({
      connection: row
        ? {
            external_id: row.external_id,
            display_name: row.display_name,
            username: row.username,
            enabled: row.enabled,
            show_to_agents: row.show_to_agents,
            refresh_expires_at: row.refresh_token_expires_at ?? null,
            updated_at: row.updated_at,
          }
        : null,
      migration_missing: !!error || !!probeError,
      env: { app_set: !!tiktokEnv() },
      callback_path: TIKTOK_CALLBACK_PATH,
      webhook_path: TIKTOK_WEBHOOK_PATH,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Body: { enabled?: boolean, show_to_agents?: boolean }. */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown
      show_to_agents?: unknown
    } | null
    const patch: Record<string, unknown> = {}
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body?.show_to_agents === 'boolean') patch.show_to_agents = body.show_to_agents
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 })
    }
    const { error } = await ctx.supabase
      .from('social_channel_configs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
      .eq('channel', 'tiktok')
    if (error) return NextResponse.json({ error: 'No se pudo guardar el cambio.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin')
    const { error } = await ctx.supabase
      .from('social_channel_configs')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('channel', 'tiktok')
    if (error) return NextResponse.json({ error: 'No se pudo desconectar.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
