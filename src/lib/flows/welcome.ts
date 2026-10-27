import { supabaseAdmin } from './admin-client'
import { startFlowRunAtNode } from './engine'

/**
 * Peru-vs-foreign welcome gate, other half — shared by WhatsApp (a
 * BSUID contact's number arrived) and Instagram / Messenger (the
 * customer typed it; it lives in contacts.contact_phone, which the
 * flows' `contact_field: phone` condition reads for social contacts).
 *
 * The contact's number was unknown on their first message, so the
 * "Bienvenida" flow's own `check_phone_presente` gate (see the Flows
 * builder) fell through to its `absent` branch and ended without
 * sending anything. Now that the number is known, that flow_run already
 * ended and won't re-evaluate on its own, so this starts a fresh run of
 * the SAME flow at its entry node — the gate runs again, finds the
 * number, and cascades to the Peru / foreign branch the flow defines.
 *
 * No node_key convention to keep in sync: `entry_node_id` is a real
 * column on `flows`. Both failure modes are logged since they'd
 * otherwise strand the lead with no welcome at all, silently.
 */
export async function restartWelcomeAfterPhoneKnown(
  accountId: string,
  contactId: string,
  conversationId: string,
  startedVia: Record<string, unknown> = { reason: 'bsuid_phone_promoted' },
): Promise<boolean> {
  const db = supabaseAdmin()
  const { data: flow, error } = await db
    .from('flows')
    .select('id, entry_node_id')
    .eq('account_id', accountId)
    // Either trigger type is entry-eligible for a brand-new contact
    // (both match on "no active flow_run" — see findEntryFlow in
    // lib/flows/engine.ts). Accounts commonly author their welcome flow
    // as `returning_message` (a superset that also re-shows the menu to
    // an existing contact), not literally `first_inbound_message` —
    // confirmed against production data, don't assume the narrower type.
    .in('trigger_type', ['first_inbound_message', 'returning_message'])
    .eq('status', 'active')
    .maybeSingle()

  if (error || !flow || !flow.entry_node_id) {
    console.error(
      `[flows] restartWelcomeAfterPhoneKnown: no active first_inbound_message flow for account ${accountId} (contact ${contactId}, conversation ${conversationId})`,
      error,
    )
    return false
  }

  const result = await startFlowRunAtNode({
    accountId,
    flowId: flow.id as string,
    nodeKey: flow.entry_node_id as string,
    contactId,
    conversationId,
    startedVia,
    // The earlier run ended at the phone gate without sending anything,
    // so this is still the first real welcome — full text, not the
    // "Sigue explorando…" reentry_text.
    isReentry: false,
  })

  if (!result.consumed) {
    console.error(
      `[flows] restartWelcomeAfterPhoneKnown: startFlowRunAtNode did not start a run for account ${accountId}, contact ${contactId}, flow ${flow.id}`,
      result,
    )
  }
  return result.consumed
}
