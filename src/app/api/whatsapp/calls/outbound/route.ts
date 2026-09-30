import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getCallPermission,
  sendCallPermissionRequest,
  startCall,
} from '@/lib/whatsapp/meta-api'
import { resolveRecipient, toRecipientTarget } from '@/lib/whatsapp/recipient'

// Outbound WhatsApp calls (migrations 071 + 073). One route, three steps
// the call button walks through:
//
//   { action: 'check', contactId }              → permission status
//   { action: 'request_permission', contactId } → sends Meta's "may we
//        call you?" message (needs the 24 h window open)
//   { action: 'start', contactId, sdp }         → rings the customer with
//        the agent's WebRTC offer; the answer lands via the webhook.

type Body = { action?: string; contactId?: string; sdp?: string }

const PERMISSION_TEXT =
  'Hola 👋 ¿Nos permites llamarte por WhatsApp para atenderte mejor?'

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body
  if (!body.contactId) {
    return NextResponse.json({ error: 'contactId required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!profile?.account_id || profile.account_role === 'viewer') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Through the caller's RLS: only contacts they may see.
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, phone, whatsapp_user_id, account_id')
    .eq('id', body.contactId)
    .maybeSingle()
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

  const recipient = resolveRecipient(contact)
  if (!recipient) {
    return NextResponse.json({ error: 'El contacto no tiene número de WhatsApp' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const { data: config } = await admin
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', contact.account_id)
    .maybeSingle()
  if (!config) return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })

  const meta = {
    phoneNumberId: config.phone_number_id as string,
    accessToken: decrypt(config.access_token),
  }

  const { data: convRows } = await admin
    .from('conversations')
    .select('id, assigned_agent_id')
    .eq('account_id', contact.account_id)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1)
  const conversation = convRows?.[0] ?? null

  try {
    if (body.action === 'check') {
      if (recipient.kind !== 'phone') {
        return NextResponse.json({ status: 'no_permission', canRequest: false, canCall: false })
      }
      const p = await getCallPermission({ ...meta, userWaId: recipient.value })
      return NextResponse.json({
        status: p.status,
        canRequest: p.canRequestPermission,
        canCall: p.canStartCall,
      })
    }

    if (body.action === 'request_permission') {
      const { messageId } = await sendCallPermissionRequest({
        ...meta,
        ...toRecipientTarget(recipient),
        bodyText: PERMISSION_TEXT,
      })
      if (conversation) {
        await admin.from('messages').insert({
          conversation_id: conversation.id,
          sender_type: 'agent',
          sender_id: user.id,
          content_type: 'text',
          content_text: `📞 ${PERMISSION_TEXT}`,
          message_id: messageId,
          status: 'sent',
        })
        await admin
          .from('conversations')
          .update({
            last_message_text: `📞 ${PERMISSION_TEXT}`,
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversation.id)
      }
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'start') {
      if (!body.sdp) return NextResponse.json({ error: 'sdp required' }, { status: 400 })
      const { callId } = await startCall({
        ...meta,
        ...toRecipientTarget(recipient),
        sdpOffer: body.sdp,
      })
      const { data: row, error } = await admin
        .from('whatsapp_calls')
        .insert({
          account_id: contact.account_id,
          conversation_id: conversation?.id ?? null,
          contact_id: contact.id,
          wa_call_id: callId,
          phone_number_id: meta.phoneNumberId,
          direction: 'outbound',
          status: 'ringing',
          ring_user_id: conversation?.assigned_agent_id ?? user.id,
          answered_by: user.id,
        })
        .select('id')
        .single()
      if (error || !row) throw error ?? new Error('Could not record the call')
      return NextResponse.json({ id: row.id })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error(`[calls/outbound] ${body.action} failed:`, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Call action failed' },
      { status: 502 },
    )
  }
}
