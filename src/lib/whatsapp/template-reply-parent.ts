import type { SupabaseClient } from '@supabase/supabase-js'
import type { TemplateButton } from '@/types'

/**
 * The customer answered (swipe-reply or template quick-reply tap) a
 * message whose Meta id (`context.id`) we may not have in `messages`.
 *
 * Resolution order, all scoped to one conversation/account:
 *  1. The message is already stored (chat template send, bot, agent).
 *  2. It was a Difusión: `broadcast_recipients.whatsapp_message_id`
 *     knows it, but Difusiones never write a `messages` row — so the
 *     template bubble is reconstructed from the broadcast's template.
 *  3. A quick-reply tap on a template sent OUTSIDE the CRM (WhatsApp
 *     Manager, raw API): if exactly one synced, approved template has a
 *     quick-reply button with that text, reconstruct it from that one.
 *     Ambiguous or unknown → no quote (nothing is invented).
 *
 * The reconstructed row keeps `message_id = context.id`, so later
 * replies/reactions to the same message resolve through step 1.
 * Never throws: any failure returns null (the reply renders unquoted).
 */

export interface ReplyParent {
  id: string
  templateName: string | null
}

interface TemplateRow {
  name: string
  body_text: string | null
  buttons: TemplateButton[] | null
  status?: string | null
}

/** "Sí " / "si" / "SÍ" compare equal. */
export function normalizeLabel(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

/**
 * The single template whose quick-reply buttons include the tapped text
 * or payload, or null when none / more than one match.
 */
export function pickTemplateByButton(
  templates: TemplateRow[],
  buttonText: string,
  payload?: string,
): TemplateRow | null {
  const wanted = [buttonText, payload ?? ''].map(normalizeLabel).filter(Boolean)
  if (wanted.length === 0) return null
  const matches = templates.filter((t) =>
    (t.buttons ?? []).some(
      (b) => b.type === 'QUICK_REPLY' && wanted.includes(normalizeLabel(b.text)),
    ),
  )
  const names = new Set(matches.map((t) => t.name))
  return names.size === 1 ? matches[0] : null
}

export async function resolveReplyParent(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contextId: string
    /** Set only for a template quick-reply tap (Meta `type: 'button'`). */
    button?: { text: string; payload?: string } | null
    /** Inbound message time, ISO — upper bound for a reconstructed row. */
    inboundAt: string
  },
): Promise<ReplyParent | null> {
  try {
    const { data: existing } = await db
      .from('messages')
      .select('id, template_name')
      .eq('message_id', args.contextId)
      .eq('conversation_id', args.conversationId)
      .maybeSingle()
    if (existing) {
      return { id: existing.id as string, templateName: (existing.template_name as string) ?? null }
    }

    let templateName: string | null = null
    let templateLanguage: string | null = null
    let sentAt: string | null = null

    const { data: rec } = await db
      .from('broadcast_recipients')
      .select('sent_at, created_at, broadcasts!inner(account_id, template_name, template_language)')
      .eq('whatsapp_message_id', args.contextId)
      .eq('broadcasts.account_id', args.accountId)
      .maybeSingle()
    if (rec) {
      const b = (Array.isArray(rec.broadcasts) ? rec.broadcasts[0] : rec.broadcasts) as
        | { template_name?: string; template_language?: string }
        | undefined
      templateName = b?.template_name ?? null
      templateLanguage = b?.template_language ?? null
      sentAt = (rec.sent_at as string) ?? (rec.created_at as string) ?? null
    }

    let template: TemplateRow | null = null
    if (templateName) {
      let q = db
        .from('message_templates')
        .select('name, body_text, buttons, status')
        .eq('account_id', args.accountId)
        .eq('name', templateName)
      if (templateLanguage) q = q.eq('language', templateLanguage)
      const { data } = await q.limit(1)
      template = (data?.[0] as TemplateRow | undefined) ?? null
    } else if (args.button?.text) {
      const { data } = await db
        .from('message_templates')
        .select('name, body_text, buttons, status')
        .eq('account_id', args.accountId)
        .eq('status', 'APPROVED')
      template = pickTemplateByButton((data ?? []) as TemplateRow[], args.button.text, args.button.payload)
      templateName = template?.name ?? null
    }
    if (!templateName) return null

    // Without a known send time, place it just before the reply.
    const createdAt =
      sentAt && Date.parse(sentAt) <= Date.parse(args.inboundAt)
        ? sentAt
        : new Date(Date.parse(args.inboundAt) - 1000).toISOString()

    const { data: inserted, error } = await db
      .from('messages')
      .insert({
        conversation_id: args.conversationId,
        sender_type: 'agent',
        content_type: 'template',
        content_text: template?.body_text ?? null,
        template_name: templateName,
        message_id: args.contextId,
        status: 'read',
        created_at: createdAt,
      })
      .select('id')
      .single()
    if (error || !inserted) {
      console.error('[template-reply-parent] insert failed:', error?.message)
      return null
    }
    return { id: inserted.id as string, templateName }
  } catch (err) {
    console.error('[template-reply-parent] failed:', err)
    return null
  }
}
