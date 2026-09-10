import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the paired-flow sync added to POST /api/flows/[id]/activate:
// activating a flow whose trigger_config.pair_flow_id points at another flow
// puts that other flow in 'draft' and syncs ai_configs.is_active to whether
// the just-activated flow has a collect_ai node. Opt-in — only exercised
// when pair_flow_id is actually set; every other activation must behave
// exactly as before this existed.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  requireRole: vi.fn().mockResolvedValue({ role: 'agent' }),
  state: {
    ownershipRow: { id: 'flow-1' } as { id: string } | null,
    flowRow: null as Record<string, unknown> | null,
    nodeRows: [] as Array<{ node_key: string; node_type: string; config: unknown }>,
    flowUpdates: [] as { id_filters: string[]; payload: Record<string, unknown> }[],
    aiConfigUpdates: [] as { account_id: string; payload: Record<string, unknown> }[],
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: h.state.ownershipRow, error: null }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'flows') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({
                data: id === h.state.flowRow?.id ? h.state.flowRow : null,
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            const filters: string[] = []
            const builder = {
              eq: (_col: string, val: string) => {
                filters.push(val)
                return builder
              },
              select: () => builder,
              maybeSingle: async () => {
                h.state.flowUpdates.push({ id_filters: filters, payload })
                // Return the row this specific update targeted, if we
                // have it — the route's main update reads this back.
                const targetId = filters[0]
                return {
                  data:
                    targetId === h.state.flowRow?.id
                      ? { ...h.state.flowRow, ...payload }
                      : { id: targetId, ...payload },
                  error: null,
                }
              },
              then: (resolve: (v: { error: null }) => void) => {
                h.state.flowUpdates.push({ id_filters: filters, payload })
                return resolve({ error: null })
              },
            }
            return builder
          },
        }
      }
      if (table === 'flow_nodes') {
        return {
          select: () => ({
            eq: async () => ({ data: h.state.nodeRows, error: null }),
          }),
        }
      }
      if (table === 'ai_configs') {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: async (_col: string, accountId: string) => {
              h.state.aiConfigUpdates.push({ account_id: accountId, payload })
              return { error: null }
            },
          }),
        }
      }
      throw new Error(`unexpected table in activate route test: ${table}`)
    },
  }),
}))

import { POST } from './route'

function request(status: 'draft' | 'active' | 'archived') {
  return new Request('http://localhost/api/flows/flow-1/activate', {
    method: 'POST',
    body: JSON.stringify({ status }),
  })
}

function ctx(id = 'flow-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  h.state.ownershipRow = { id: 'flow-1' }
  h.state.flowRow = null
  h.state.nodeRows = []
  h.state.flowUpdates = []
  h.state.aiConfigUpdates = []
})

describe('POST /api/flows/[id]/activate — paired-flow sync', () => {
  it('does nothing extra when trigger_config has no pair_flow_id — unaffected by this feature', async () => {
    h.state.flowRow = {
      id: 'flow-1',
      account_id: 'acct-1',
      name: 'Some flow',
      trigger_type: 'manual',
      trigger_config: {},
      entry_node_id: 'n1',
    }
    h.state.nodeRows = [
      { node_key: 'n1', node_type: 'end', config: {} },
    ]

    const res = await POST(request('active'), ctx())
    expect(res.status).toBe(200)

    // Only the flow's own status update happened — no paired-flow
    // deactivation, no ai_configs touch.
    expect(h.state.flowUpdates).toHaveLength(1)
    expect(h.state.flowUpdates[0].payload.status).toBe('active')
    expect(h.state.aiConfigUpdates).toHaveLength(0)
  })

  it('activating the AI flow deactivates its paired manual flow and turns ai_configs.is_active ON (has a collect_ai node)', async () => {
    h.state.flowRow = {
      id: 'flow-ai',
      account_id: 'acct-1',
      name: 'FAQ bot',
      trigger_type: 'first_inbound_message',
      trigger_config: { pair_flow_id: 'flow-manual' },
      entry_node_id: 'start',
    }
    h.state.nodeRows = [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'ask' } },
      { node_key: 'ask', node_type: 'collect_ai', config: { fields: [{ key: 'x', label: 'X', required: true }], max_turns: 3, next_node_key: 'end' } },
      { node_key: 'end', node_type: 'end', config: {} },
    ]

    const res = await POST(request('active'), ctx('flow-ai'))
    expect(res.status).toBe(200)

    expect(
      h.state.flowUpdates.some(
        (u) => u.id_filters.includes('flow-manual') && u.payload.status === 'draft',
      ),
    ).toBe(true)
    expect(h.state.aiConfigUpdates).toEqual([
      { account_id: 'acct-1', payload: { is_active: true } },
    ])
  })

  it('activating the manual (no-AI) flow deactivates the paired AI flow and turns ai_configs.is_active OFF (no collect_ai node)', async () => {
    h.state.flowRow = {
      id: 'flow-manual',
      account_id: 'acct-1',
      name: 'FAQ bot (Manual, sin IA)',
      trigger_type: 'first_inbound_message',
      trigger_config: { pair_flow_id: 'flow-ai' },
      entry_node_id: 'start',
    }
    h.state.nodeRows = [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'ask' } },
      { node_key: 'ask', node_type: 'collect_input', config: { prompt_text: '¿Qué necesitas?', var_key: 'x', next_node_key: 'end' } },
      { node_key: 'end', node_type: 'end', config: {} },
    ]

    const res = await POST(request('active'), ctx('flow-manual'))
    expect(res.status).toBe(200)

    expect(
      h.state.flowUpdates.some(
        (u) => u.id_filters.includes('flow-ai') && u.payload.status === 'draft',
      ),
    ).toBe(true)
    expect(h.state.aiConfigUpdates).toEqual([
      { account_id: 'acct-1', payload: { is_active: false } },
    ])
  })

  it('never syncs when activating to draft/archived — pairing only fires on activation', async () => {
    h.state.flowRow = {
      id: 'flow-ai',
      account_id: 'acct-1',
      name: 'FAQ bot',
      trigger_type: 'first_inbound_message',
      trigger_config: { pair_flow_id: 'flow-manual' },
      entry_node_id: 'start',
    }
    // Not used for a draft/archived transition — the validator (and the
    // node reload) only runs when status === 'active'.
    const res = await POST(request('draft'), ctx('flow-ai'))
    expect(res.status).toBe(200)
    expect(h.state.aiConfigUpdates).toHaveLength(0)
    expect(h.state.flowUpdates.some((u) => u.id_filters.includes('flow-manual'))).toBe(false)
  })

  it('does not sync at all when activation is blocked by a validation error', async () => {
    h.state.flowRow = {
      id: 'flow-ai',
      account_id: 'acct-1',
      name: 'FAQ bot',
      trigger_type: 'first_inbound_message',
      trigger_config: { pair_flow_id: 'flow-manual' },
      entry_node_id: null, // missing entry node — a validator blocker
    }
    h.state.nodeRows = []

    const res = await POST(request('active'), ctx('flow-ai'))
    expect(res.status).toBe(422)
    expect(h.state.flowUpdates).toHaveLength(0)
    expect(h.state.aiConfigUpdates).toHaveLength(0)
  })
})
