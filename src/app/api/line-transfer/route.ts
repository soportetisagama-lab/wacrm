import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getLineTransferConfig, greetingName } from '@/lib/line-transfer'

/**
 * "Derivar a otra línea" — see src/lib/line-transfer.ts for the config
 * and why a transfer is a template sent BY the target line.
 *
 * GET  → the lines this deployment can transfer to ({ id, label } only;
 *        URLs and API keys never leave the server). Empty when unset.
 * POST { conversationId, targetId, topic } → on the target line:
 *        find-or-create the contact (tagged "Derivado de <from>"), then
 *        send its transfer template. On success, leaves a note on the
 *        contact here so the source line knows it was handed over.
 */

export async function GET() {
  try {
    await requireRole('agent')
    const config = getLineTransferConfig()
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
    const { supabase, userId, accountId } = await requireRole('agent')
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
      .select('id, contact_id, contacts ( id, name, phone )')
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
        params: [greetingName(contact.name), topic],
      },
    })
    if (!sent.ok) {
      return NextResponse.json(
        { error: `${target.label} no pudo enviar la plantilla: ${sent.message}` },
        { status: 502 },
      )
    }

    // Best-effort breadcrumb on this side; the transfer already happened.
    const { error: noteError } = await supabase.from('contact_notes').insert({
      contact_id: contact.id,
      account_id: accountId,
      user_id: userId,
      note_text: `🔀 Derivado a ${target.label} — tema: ${topic}. ${target.label} ya le escribió al cliente desde su número.`,
    })
    if (noteError) console.error('[line-transfer] note insert failed:', noteError.message)

    return NextResponse.json({ ok: true, target: target.label })
  } catch (err) {
    return toErrorResponse(err)
  }
}
