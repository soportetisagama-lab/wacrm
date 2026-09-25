import { NextResponse } from 'next/server'
import { ForbiddenError, requireRole, toErrorResponse } from '@/lib/auth/account'
import type { AccountRole } from '@/lib/auth/roles'
import {
  buildTransferNote,
  getLineTransferConfig,
  TEMPLATE_GREETING,
  transferNoticeText,
  type TranscriptMessage,
} from '@/lib/line-transfer'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

/** How many of the source chat's latest messages travel with the transfer. */
const TRANSFER_HISTORY_LIMIT = 40

/** Only ATC and admins route customers between lines — advisors never see it. */
const TRANSFER_ROLES: readonly AccountRole[] = ['atc', 'admin', 'owner']

/**
 * "Derivar a otra línea" — see src/lib/line-transfer.ts for the config
 * and why a transfer is a template sent BY the target line.
 *
 * GET  → the lines this deployment can transfer to ({ id, label } only;
 *        URLs and API keys never leave the server). Empty when unset,
 *        or for roles outside TRANSFER_ROLES — which hides the button.
 * POST { conversationId, targetId, topic } → on the target line:
 *        find-or-create the contact (tagged "Derivado de <from>"), then
 *        send its transfer template. On success, tells the customer in
 *        this chat (transferNoticeText), sends the target the handover
 *        note + history, and leaves a note on the contact here.
 */

export async function GET() {
  try {
    const { role } = await requireRole('agent')
    const config = TRANSFER_ROLES.includes(role) ? getLineTransferConfig() : null
    return NextResponse.json({
      targets: config?.targets.map(({ id, label }) => ({ id, label })) ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; message: string }

async function callTarget(url: string, apiKey: string, path: string, body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const json = (await res.json().catch(() => ({}))) as {
      data?: Record<string, unknown>
      error?: { code?: string; message?: string }
    }
    if (!res.ok || !json.data) {
      return { ok: false, message: json.error?.message || `HTTP ${res.status}` }
    }
    return { ok: true, data: json.data }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, userId, accountId, role } = await requireRole('agent')
    if (!TRANSFER_ROLES.includes(role)) {
      throw new ForbiddenError('Solo ATC y administradores pueden derivar a otra línea.')
    }
    const config = getLineTransferConfig()
    const body = (await request.json().catch(() => ({}))) as {
      conversationId?: string
      targetId?: string
      topic?: string
    }
    const topic = body.topic?.trim()
    const target = config?.targets.find((t) => t.id === body.targetId)
    if (!config || !target) {
      return NextResponse.json({ error: 'Línea de destino no configurada.' }, { status: 400 })
    }
    if (!body.conversationId || !topic) {
      return NextResponse.json({ error: 'Falta la conversación o el tema.' }, { status: 400 })
    }

    // RLS-scoped: the caller can only transfer a conversation they can see.
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, contact_id, assigned_agent_id, contacts ( id, name, phone )')
      .eq('id', body.conversationId)
      .maybeSingle()
    const contactRow = conversation?.contacts as
      | { id: string; name: string | null; phone: string | null }
      | { id: string; name: string | null; phone: string | null }[]
      | null
      | undefined
    const contact = Array.isArray(contactRow) ? contactRow[0] : contactRow
    if (!conversation || !contact) {
      return NextResponse.json({ error: 'Conversación no encontrada.' }, { status: 404 })
    }
    const digits = contact.phone?.replace(/\D/g, '')
    if (!digits) {
      return NextResponse.json(
        { error: 'El cliente no tiene número de celular — pídeselo antes de derivarlo.' },
        { status: 400 },
      )
    }
    const to = `+${digits}`

    const created = await callTarget(target.url, target.apiKey, '/api/v1/contacts', {
      phone: to,
      name: contact.name ?? undefined,
      tags: [`Derivado de ${config.from}`],
    })
    if (!created.ok) {
      return NextResponse.json(
        { error: `${target.label} no pudo registrar el contacto: ${created.message}` },
        { status: 502 },
      )
    }

    const sent = await callTarget(target.url, target.apiKey, '/api/v1/messages', {
      to,
      type: 'template',
      template: {
        name: target.template,
        language: target.language,
        params: [TEMPLATE_GREETING, topic],
      },
    })
    if (!sent.ok) {
      return NextResponse.json(
        { error: `${target.label} no pudo enviar la plantilla: ${sent.message}` },
        { status: 502 },
      )
    }

    // Tell the customer, in THIS chat, why another Sagama number just
    // wrote to them. Only after the target's template succeeded, so we
    // never announce a transfer that didn't happen. Free-form text, so it
    // fails outside the 24h window — reported, never fatal.
    let noticeSent = false
    try {
      await sendMessageToConversation(supabase, accountId, {
        conversationId: conversation.id,
        messageType: 'text',
        contentText: transferNoticeText({ topic, targetLabel: target.label }),
      })
      noticeSent = true
      // With no human owning this chat, whatever the customer sends next
      // is handled by lib/line-transfer-outbound.ts: a capped farewell for
      // thanks, the AI (with the transfer note) for anything else — so
      // lift a pause left by an earlier bot handoff.
      if (!conversation.assigned_agent_id) {
        const { error: aiErr } = await supabase
          .from('conversations')
          .update({ ai_autoreply_disabled: false })
          .eq('id', conversation.id)
        if (aiErr) console.error('[line-transfer] AI resume failed:', aiErr.message)
      }
    } catch (err) {
      console.error('[line-transfer] customer notice failed:', err instanceof Error ? err.message : err)
    }

    // Hand the receiving line the context + this chat's recent history as
    // a note on its contact. Best-effort: the customer already got the
    // template, so a failure here only costs the history, not the transfer.
    const targetContactId = created.data.id
    let historySent = false
    if (typeof targetContactId === 'string') {
      const [{ data: recent }, { data: profile }] = await Promise.all([
        supabase
          .from('messages')
          .select('sender_type, content_type, content_text, media_url, created_at')
          .eq('conversation_id', conversation.id)
          .order('created_at', { ascending: false })
          .limit(TRANSFER_HISTORY_LIMIT),
        supabase.from('profiles').select('full_name').eq('user_id', userId).maybeSingle(),
      ])
      const noteSent = await callTarget(target.url, target.apiKey, `/api/v1/contacts/${targetContactId}/notes`, {
        text: buildTransferNote({
          from: config.from,
          topic,
          agentName: (profile?.full_name as string | undefined) ?? null,
          messages: ((recent ?? []) as TranscriptMessage[]).reverse(),
        }),
      })
      historySent = noteSent.ok
      if (!noteSent.ok) console.error('[line-transfer] history note failed:', noteSent.message)
    }

    // Best-effort breadcrumb on this side; the transfer already happened.
    const { error: noteError } = await supabase.from('contact_notes').insert({
      contact_id: contact.id,
      account_id: accountId,
      user_id: userId,
      note_text: `🔀 Derivado a ${target.label} — tema: ${topic}. ${target.label} ya le escribió al cliente desde su número.`,
    })
    if (noteError) console.error('[line-transfer] note insert failed:', noteError.message)

    return NextResponse.json({ ok: true, target: target.label, historySent, noticeSent })
  } catch (err) {
    return toErrorResponse(err)
  }
}
