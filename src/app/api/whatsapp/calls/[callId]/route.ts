import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { callAction } from '@/lib/whatsapp/meta-api'

// Answer / reject / hang up an inbound WhatsApp call (migration 071).
//
//   POST { action: 'accept', sdp }   — the agent's WebRTC answer. The
//        first teammate to accept claims the call (ringing → accepted
//        is a conditional update); everyone else gets 409 and their
//        ringing UI closes off the realtime UPDATE.
//   POST { action: 'reject' }        — decline while ringing.
//   POST { action: 'terminate' }     — hang up an answered call.

type Body = { action?: string; sdp?: string }

export async function POST(
  request: Request,
  { params }: { params: Promise<{ callId: string }> },
) {
  const { callId } = await params
  const body = (await request.json().catch(() => ({}))) as Body

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

  // Through the caller's RLS: they can only act on calls they can see
  // (an Asesor → their own conversations' calls).
  const { data: call } = await supabase
    .from('whatsapp_calls')
    .select('id, account_id, wa_call_id, phone_number_id, status, answered_by, answered_at')
    .eq('id', callId)
    .maybeSingle()
  if (!call) return NextResponse.json({ error: 'Call not found' }, { status: 404 })

  const admin = supabaseAdmin()
  const { data: config } = await admin
    .from('whatsapp_config')
    .select('access_token')
    .eq('account_id', call.account_id)
    .eq('phone_number_id', call.phone_number_id)
    .maybeSingle()
  if (!config) return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
  const meta = {
    phoneNumberId: call.phone_number_id as string,
    accessToken: decrypt(config.access_token),
    callId: call.wa_call_id as string,
  }

  try {
    if (body.action === 'accept') {
      if (!body.sdp) return NextResponse.json({ error: 'sdp required' }, { status: 400 })
      const { data: claimed } = await admin
        .from('whatsapp_calls')
        .update({ status: 'accepted', answered_by: user.id, answered_at: new Date().toISOString() })
        .eq('id', call.id)
        .eq('status', 'ringing')
        .select('id')
      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ error: 'already_handled' }, { status: 409 })
      }
      try {
        // pre_accept lets the media path come up before accept, so the
        // first words aren't clipped.
        await callAction({ ...meta, action: 'pre_accept', sdpAnswer: body.sdp })
        await callAction({ ...meta, action: 'accept', sdpAnswer: body.sdp })
      } catch (err) {
        await admin
          .from('whatsapp_calls')
          .update({ status: 'failed', ended_at: new Date().toISOString() })
          .eq('id', call.id)
        throw err
      }
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'reject') {
      await admin
        .from('whatsapp_calls')
        .update({ status: 'rejected', ended_at: new Date().toISOString() })
        .eq('id', call.id)
        .eq('status', 'ringing')
      await callAction({ ...meta, action: 'reject' })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'terminate') {
      if (call.status === 'accepted' && call.answered_by !== user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const answeredAt = call.answered_at ? new Date(call.answered_at as string).getTime() : null
      await admin
        .from('whatsapp_calls')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString(),
          duration_seconds: answeredAt ? Math.round((Date.now() - answeredAt) / 1000) : null,
        })
        .eq('id', call.id)
        .eq('status', 'accepted')
      await callAction({ ...meta, action: 'terminate' })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error(`[calls] ${body.action} failed:`, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Call action failed' },
      { status: 502 },
    )
  }
}
