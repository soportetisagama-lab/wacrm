import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { fetchPageInfo, resolvePageAccessToken, subscribePageToApp } from '@/lib/social/graph'
import { isSocialChannel, type SocialChannel } from '@/lib/channels/types'
import { isUniqueViolation } from '@/lib/contacts/dedupe'

// Instagram / Messenger connection settings — owner/admin only (both
// here and in the RLS of social_channel_configs, migration 080). The page
// token is stored encrypted and never returned to the browser.

interface ConfigRow {
  channel: SocialChannel
  external_id: string
  page_id: string
  access_token: string
  display_name: string | null
  username: string | null
  enabled: boolean
  show_to_agents: boolean
  updated_at: string
}

function publicView(row: Omit<ConfigRow, 'access_token'> | undefined) {
  if (!row) return null
  return {
    channel: row.channel,
    external_id: row.external_id,
    page_id: row.page_id,
    display_name: row.display_name,
    username: row.username,
    enabled: row.enabled,
    updated_at: row.updated_at,
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data, error } = await ctx.supabase
      .from('social_channel_configs')
      .select('channel, external_id, page_id, display_name, username, enabled, show_to_agents, updated_at')
      .eq('account_id', ctx.accountId)
    if (error) {
      // Most likely migration 080 hasn't been run yet.
      return NextResponse.json(
        { error: 'No se pudo leer la configuración. ¿Ya se ejecutó la migración 080?', migration_missing: true },
        { status: 200 },
      )
    }
    const rows = (data ?? []) as Omit<ConfigRow, 'access_token'>[]
    const byChannel = (c: SocialChannel) => rows.find((r) => r.channel === c)
    return NextResponse.json({
      instagram: publicView(byChannel('instagram')),
      messenger: publicView(byChannel('messenger')),
      show_to_agents: rows.some((r) => r.show_to_agents),
      env: {
        verify_token_set: !!process.env.META_SOCIAL_VERIFY_TOKEN,
        app_secret_set: !!(process.env.META_SOCIAL_APP_SECRET || process.env.META_APP_SECRET),
      },
      webhook_path: '/api/social/webhook',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Connect a Facebook Page (Messenger) and/or its linked Instagram
 * professional account. Body: { page_id, access_token?, messenger, instagram }.
 * `access_token` may be left empty to keep the one already saved.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as {
      page_id?: string
      access_token?: string
      messenger?: boolean
      instagram?: boolean
    } | null
    const pageId = body?.page_id?.trim()
    if (!pageId || !/^\d+$/.test(pageId)) {
      return NextResponse.json({ error: 'Escribe el ID de la página de Facebook (solo números).' }, { status: 400 })
    }
    if (!body?.messenger && !body?.instagram) {
      return NextResponse.json({ error: 'Elige al menos un canal: Messenger o Instagram.' }, { status: 400 })
    }

    let accessToken = body.access_token?.trim() ?? ''
    const { data: existingRows } = await ctx.supabase
      .from('social_channel_configs')
      .select('channel, access_token, page_id, show_to_agents')
      .eq('account_id', ctx.accountId)
    const existing = (existingRows ?? []) as Pick<ConfigRow, 'channel' | 'access_token' | 'page_id' | 'show_to_agents'>[]
    if (!accessToken) {
      const same = existing.find((r) => r.page_id === pageId)
      if (!same) {
        return NextResponse.json({ error: 'Pega el token de acceso de la página.' }, { status: 400 })
      }
      try {
        accessToken = decrypt(same.access_token)
      } catch {
        return NextResponse.json({ error: 'El token guardado no se puede leer. Pégalo de nuevo.' }, { status: 400 })
      }
    }

    accessToken = await resolvePageAccessToken({ pageId, accessToken })

    let page
    try {
      page = await fetchPageInfo({ pageId, accessToken })
    } catch (err) {
      return NextResponse.json(
        { error: `Meta rechazó la página o el token: ${err instanceof Error ? err.message : 'error desconocido'}` },
        { status: 400 },
      )
    }
    if (body.instagram && !page.instagram) {
      return NextResponse.json(
        { error: 'Esta página no tiene una cuenta profesional de Instagram vinculada. Vincúlala en Meta Business Suite.' },
        { status: 400 },
      )
    }

    // Without this subscription Meta doesn't deliver the page's messages
    // to our webhook (it covers the linked Instagram account too).
    try {
      await subscribePageToApp({ pageId, accessToken })
    } catch (err) {
      return NextResponse.json(
        { error: `No se pudo suscribir la página al webhook: ${err instanceof Error ? err.message : 'error desconocido'}` },
        { status: 400 },
      )
    }

    const showToAgents = existing.some((r) => r.show_to_agents)
    const encrypted = encrypt(accessToken)
    const now = new Date().toISOString()
    const rows: Record<string, unknown>[] = []
    if (body.messenger) {
      rows.push({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        channel: 'messenger',
        external_id: page.id,
        page_id: page.id,
        access_token: encrypted,
        display_name: page.name,
        username: null,
        enabled: true,
        show_to_agents: showToAgents,
        updated_at: now,
      })
    }
    if (body.instagram && page.instagram) {
      rows.push({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        channel: 'instagram',
        external_id: page.instagram.id,
        page_id: page.id,
        access_token: encrypted,
        display_name: page.instagram.name ?? page.name,
        username: page.instagram.username,
        enabled: true,
        show_to_agents: showToAgents,
        updated_at: now,
      })
    }

    const { error } = await ctx.supabase
      .from('social_channel_configs')
      .upsert(rows, { onConflict: 'account_id,channel' })
    if (error) {
      if (isUniqueViolation(error)) {
        return NextResponse.json(
          { error: 'Esta página o cuenta de Instagram ya está conectada a otra cuenta del CRM.' },
          { status: 409 },
        )
      }
      console.error('[social config] save failed:', error)
      return NextResponse.json({ error: 'No se pudo guardar la configuración.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      page: { id: page.id, name: page.name },
      instagram: page.instagram,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Body: { show_to_agents?: boolean, channel?: 'instagram'|'messenger', enabled?: boolean }. */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as {
      show_to_agents?: unknown
      channel?: unknown
      enabled?: unknown
    } | null
    if (!body) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 })

    if (typeof body.show_to_agents === 'boolean') {
      const { error } = await ctx.supabase
        .from('social_channel_configs')
        .update({ show_to_agents: body.show_to_agents, updated_at: new Date().toISOString() })
        .eq('account_id', ctx.accountId)
      if (error) return NextResponse.json({ error: 'No se pudo guardar el cambio.' }, { status: 500 })
    }

    if (body.channel !== undefined || body.enabled !== undefined) {
      if (!isSocialChannel(body.channel) || typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'Canal o estado inválido.' }, { status: 400 })
      }
      const { error } = await ctx.supabase
        .from('social_channel_configs')
        .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
        .eq('account_id', ctx.accountId)
        .eq('channel', body.channel)
      if (error) return NextResponse.json({ error: 'No se pudo guardar el cambio.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** ?channel=instagram|messenger — disconnect one channel. */
export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const channel = new URL(request.url).searchParams.get('channel')
    if (!isSocialChannel(channel)) {
      return NextResponse.json({ error: 'Canal inválido.' }, { status: 400 })
    }
    const { error } = await ctx.supabase
      .from('social_channel_configs')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('channel', channel)
    if (error) return NextResponse.json({ error: 'No se pudo desconectar.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
