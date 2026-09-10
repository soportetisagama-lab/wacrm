import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateFlowForActivation } from '@/lib/flows/validate'

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue. Drafts and archives are unconditional — users
 * need to be able to save broken-work-in-progress and pause flows
 * without first fixing them.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 *
 * Paired-flow sync (opt-in, see below): activating a flow whose
 * `trigger_config.pair_flow_id` points at another flow ALSO — in the
 * same request, only after the activation above has actually
 * succeeded — puts that other flow into 'draft' and syncs
 * `ai_configs.is_active` to whether the flow just activated contains
 * at least one `collect_ai` node. Built for one specific case: a "with
 * AI" flow and a manual "sin IA" clone of it (collect_ai nodes swapped
 * for collect_input) that must never both be active at once, and where
 * switching between them should also flip the account's AI master
 * switch — so a business can go "fully manual" or "with AI" by
 * activating one flow, without a second, easy-to-forget step in AI
 * settings.
 *
 * Deliberately opt-in via `pair_flow_id` (plain JSONB on
 * `trigger_config`, no schema change) rather than a blanket rule for
 * every activation: a flow that never sets it activates exactly as it
 * did before this existed — zero behavior change for every other flow
 * on this account or any other.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  // Changing status (activate / draft / archive) is a write — the RLS
  // flows_update policy requires `agent`, but the service-role client
  // below bypasses RLS, so enforce the role here (a viewer passes the
  // membership-only ownership check).
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | { status?: 'draft' | 'active' | 'archived' }
    | null
  const status = body?.status
  if (!status || !['draft', 'active', 'archived'].includes(status)) {
    return NextResponse.json(
      { error: "status must be one of 'draft' | 'active' | 'archived'" },
      { status: 400 },
    )
  }

  // Ownership via RLS — caller's client.
  const { data: existing } = await supabase
    .from('flows')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const admin = supabaseAdmin()

  // Loaded here (before the status write) only when activating — the
  // validator needs it regardless, and the paired-flow sync below
  // reuses the exact same rows rather than re-querying.
  let nodesForSync: Array<{ node_type: string }> = []
  let flowForSync: {
    account_id: string
    trigger_config: Record<string, unknown>
  } | null = null

  if (status === 'active') {
    // Re-load with the full payload the validator needs.
    const [{ data: flow }, { data: nodes }] = await Promise.all([
      admin
        .from('flows')
        .select('account_id, name, trigger_type, trigger_config, entry_node_id')
        .eq('id', id)
        .maybeSingle(),
      admin
        .from('flow_nodes')
        .select('node_key, node_type, config')
        .eq('flow_id', id),
    ])
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const issues = validateFlowForActivation(
      flow as {
        name: string
        trigger_type:
          | 'keyword'
          | 'first_inbound_message'
          | 'manual'
          | 'returning_message'
        trigger_config: Record<string, unknown>
        entry_node_id: string | null
      },
      (nodes ?? []) as Array<{
        node_key: string
        node_type: string
        config: Record<string, unknown>
      }>,
    )
    const blockers = issues.filter((i) => i.severity === 'error')
    if (blockers.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot activate flow — fix the issues below first.',
          issues,
        },
        { status: 422 },
      )
    }
    flowForSync = flow as { account_id: string; trigger_config: Record<string, unknown> }
    nodesForSync = (nodes ?? []) as Array<{ node_type: string }>
  }

  const { data: updated, error } = await admin
    .from('flows')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Paired-flow sync — see this route's doc comment. Only ever runs
  // when the flow just activated actually opted in via
  // trigger_config.pair_flow_id; every other activation is unaffected.
  // Best-effort in the sense that a failure here doesn't roll back the
  // activation that already succeeded above — logged loudly instead,
  // since a silent failure here would leave two flows both active or
  // the AI switch out of sync with no visible error.
  if (status === 'active' && flowForSync) {
    const pairFlowId = flowForSync.trigger_config?.pair_flow_id
    if (typeof pairFlowId === 'string' && pairFlowId) {
      const { error: pairError } = await admin
        .from('flows')
        .update({ status: 'draft', updated_at: new Date().toISOString() })
        .eq('id', pairFlowId)
        .eq('account_id', flowForSync.account_id) // never cross-tenant, even on a malformed config
      if (pairError) {
        console.error('[flows] paired-flow deactivation failed:', pairError.message)
      }

      const requiresAi = nodesForSync.some((n) => n.node_type === 'collect_ai')
      const { error: aiError } = await admin
        .from('ai_configs')
        .update({ is_active: requiresAi })
        .eq('account_id', flowForSync.account_id)
      if (aiError) {
        console.error('[flows] ai_configs sync on flow activation failed:', aiError.message)
      }
    }
  }

  return NextResponse.json({ flow: updated })
}
