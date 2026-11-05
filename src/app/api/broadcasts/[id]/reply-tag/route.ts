import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  normalizeReplyTagName,
  resolveReplyTagId,
  tagBroadcastRepliers,
} from '@/lib/broadcasts/reply-tag'

/**
 * POST /api/broadcasts/[id]/reply-tag — "Etiquetar a los que respondieron".
 *
 * Body: { tagName: string } — an existing account tag (matched ignoring
 * case) or a new name, which is created. Saves it as the broadcast's
 * `reply_tag_id` (future repliers get it from the webhook) and puts it
 * now on every recipient already marked 'replied'.
 *
 * 200 { tagId, tagName, replied, tagged }
 *
 * DELETE — stops tagging new repliers (reply_tag_id = NULL). Tags already
 * put on contacts stay.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Same gate as the other Difusiones actions: admin-only.
    const { supabase, accountId, userId } = await requireRole('admin')
    const { id } = await params

    const body = (await request.json().catch(() => null)) as { tagName?: unknown } | null
    const tagName = normalizeReplyTagName(typeof body?.tagName === 'string' ? body.tagName : '')
    if (!tagName) {
      return NextResponse.json({ error: 'Falta el nombre de la etiqueta.' }, { status: 400 })
    }

    const { data: bc, error: bcErr } = await supabase
      .from('broadcasts')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (bcErr) throw bcErr
    if (!bc) return NextResponse.json({ error: 'Difusión no encontrada.' }, { status: 404 })

    const tagId = await resolveReplyTagId(supabase, { accountId, userId, name: tagName })

    const { error: updErr } = await supabase
      .from('broadcasts')
      .update({ reply_tag_id: tagId })
      .eq('id', id)
      .eq('account_id', accountId)
    if (updErr) throw updErr

    const { replied, tagged } = await tagBroadcastRepliers(supabase, id, tagId)
    return NextResponse.json({ tagId, tagName, replied, tagged })
  } catch (error) {
    console.error('Error in broadcast reply-tag POST:', error)
    return toErrorResponse(error)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { data, error } = await supabase
      .from('broadcasts')
      .update({ reply_tag_id: null })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
    if (error) throw error
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Difusión no encontrada.' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error in broadcast reply-tag DELETE:', error)
    return toErrorResponse(error)
  }
}
