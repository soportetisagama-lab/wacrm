import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { canSeeQuickReply, isQuickReplyAdmin } from '@/lib/quick-replies'

// Quick replies — reusable snippets (plain text or a saved interactive
// message). Admin-created ones are shared with the whole account;
// everyone else's are personal (migration 067). GET lists; POST
// creates. Mirrors the automations route: RLS-scoped read via the user
// client, service-role write after an explicit role check.

export async function GET() {
  try {
    const { supabase, userId, role, accountId } = await getCurrentAccount()
    const isAdmin = isQuickReplyAdmin(role)
    // RLS (quick_replies_select) scopes to the caller's account and to
    // shared + own rows (admins: all). Filtered again here so a
    // database still missing migration 067 never leaks personal rows.
    const { data, error } = await supabase
      .from('quick_replies')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const rows = ((data ?? []) as { user_id: string; is_shared?: boolean | null }[]).filter(
      (r) => canSeeQuickReply({ userId, role }, r),
    )

    // Admins see advisors' personal replies — label whose they are.
    const otherAuthors = isAdmin
      ? [...new Set(rows.filter((r) => r.is_shared === false && r.user_id !== userId).map((r) => r.user_id))]
      : []
    const names = new Map<string, string>()
    if (otherAuthors.length > 0) {
      const { data: profiles } = await supabaseAdmin()
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', accountId)
        .in('user_id', otherAuthors)
      for (const p of profiles ?? []) names.set(p.user_id, p.full_name)
    }

    return NextResponse.json({
      quick_replies: rows.map((r) => ({
        ...r,
        is_shared: r.is_shared !== false,
        author_name: names.get(r.user_id) ?? null,
      })),
      viewer: { user_id: userId, is_admin: isAdmin },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const kind = body.kind === 'interactive' ? 'interactive' : 'text'
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }

  let content_text: string | null = null
  let interactive_payload: unknown = null

  if (kind === 'interactive') {
    const result = validateInteractivePayload(body.interactive_payload)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    interactive_payload = body.interactive_payload
  } else {
    const text = typeof body.content_text === 'string' ? body.content_text : ''
    if (!text.trim()) {
      return NextResponse.json(
        { error: 'content_text is required for text quick replies' },
        { status: 400 },
      )
    }
    content_text = text
  }

  const { data, error } = await supabaseAdmin()
    .from('quick_replies')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      // Admin-created → whole account; anyone else's → only their own.
      is_shared: isQuickReplyAdmin(ctx.role),
      title,
      kind,
      content_text,
      interactive_payload,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ quick_reply: data }, { status: 201 })
}
