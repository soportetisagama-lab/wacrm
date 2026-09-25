import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/leads/pending
 *
 * Machine-to-machine endpoint for the separate PHP lead-intake app
 * ("XLR9") deployed alongside this CRM. It has its own MySQL database
 * and no visibility into this account's WhatsApp inbox, so it can't
 * tell which contacts still need a lead created from a fresh
 * conversation. This returns that list: open or pending conversations
 * with at least one unread inbound message AND no agent assigned yet, for the
 * one account this deployment serves — once someone in the CRM claims
 * the conversation (assigned_agent_id set), it's "derivado" already
 * and drops off this list even if it's still unread.
 *
 * 'pending' is included on purpose: it's the status a bot handoff
 * leaves behind ("waiting for an advisor"), i.e. exactly the
 * conversations that most need deriving.
 *
 * "Pending" here means "conversation still open, unread, and
 * unassigned" — it does NOT check whether a lead already exists in
 * the PHP app's MySQL `project_list` table (this app has no access to
 * that database). A number can still show up here after a lead was
 * created for it, if nobody has claimed the conversation in the CRM
 * yet.
 *
 * Auth re-uses AUTOMATION_CRON_SECRET (see /api/flows/cron) rather
 * than provisioning a second secret — same "one secret, multiple
 * server-to-server callers" tradeoff made there.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = process.env.LEADS_PENDING_ACCOUNT_ID
  if (!accountId) {
    return NextResponse.json({ error: 'LEADS_PENDING_ACCOUNT_ID not configured' }, { status: 503 })
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('conversations')
    .select('id, unread_count, last_message_at, contacts ( phone, name )')
    .eq('account_id', accountId)
    .in('status', ['open', 'pending'])
    .gt('unread_count', 0)
    .is('assigned_agent_id', null)
    .order('last_message_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  type Row = {
    id: string
    unread_count: number
    last_message_at: string | null
    contacts: Contact | Contact[] | null
  }
  type Contact = { phone: string | null; name: string | null }

  // Phone-less contacts (WhatsApp usernames that hide the number) are
  // kept, with phone null: the PHP side lists them as "sin número" so
  // the ATC knows to ask for it in the chat instead of never seeing them.
  const leads = (data as Row[]).map((r) => {
    const contact = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts
    return {
      conversation_id: r.id,
      phone: contact?.phone ?? null,
      name: contact?.name ?? null,
      unread_count: r.unread_count,
      last_message_at: r.last_message_at,
    }
  })

  return NextResponse.json({ leads })
}
