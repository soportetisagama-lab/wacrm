import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the debounce-recovery sweep added to this cron route
// (sweepOrphanedDebounceWindows) — the safety net for a debounce "owner"
// instance (src/lib/ai/auto-reply.ts) that dies mid-wait and leaves
// conversations.ai_debounce_until set with nobody left to act on it.
//
// The existing timeout/nudge jobs in this route have no test coverage
// today (no admin-client mock existed before this file); this suite only
// covers the new sweep, driven through the real `GET` handler.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  runAutoReplyNow: vi.fn().mockResolvedValue(undefined),
  engineSendText: vi.fn().mockResolvedValue(undefined),
  state: {
    flowRuns: [] as Record<string, unknown>[],
    conversations: [] as {
      id: string
      account_id: string
      contact_id: string
      ai_debounce_until: string | null
    }[],
    whatsappConfigs: {} as Record<string, { user_id: string } | undefined>,
    // Keyed by `${flow_id}:${node_key}`.
    flowNodes: {} as Record<string, { node_type: string; config: Record<string, unknown> }>,
    flowRunEvents: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/ai/auto-reply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/auto-reply')>()
  return { ...actual, runAutoReplyNow: h.runAutoReplyNow }
})

vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))

/** Minimal chainable update() builder shared by the `flow_runs` mock —
 *  supports both `.update(p).eq(...).eq(...).select(...)` (timeout
 *  marking) and `.update(p).eq(...)` awaited directly with no
 *  `.select()` (the nudge timestamp write) — see route.ts. */
function flowRunsUpdateChain(payload: Record<string, unknown>) {
  const filters: [string, unknown][] = []
  function apply() {
    const matched = h.state.flowRuns.filter((r) =>
      filters.every(([col, val]) => r[col] === val),
    )
    for (const m of matched) Object.assign(m, payload)
    return { data: matched.map((r) => ({ id: r.id })), error: null }
  }
  const chain = {
    eq(col: string, val: unknown) {
      filters.push([col, val])
      return chain
    },
    select: () => Promise.resolve(apply()),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(apply()).then(res, rej),
  }
  return chain
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'flow_runs') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: h.state.flowRuns, error: null }),
          }),
          update: (payload: Record<string, unknown>) => flowRunsUpdateChain(payload),
        }
      }
      if (table === 'flow_nodes') {
        return {
          select: () => ({
            eq: (_col1: string, flowId: string) => ({
              eq: (_col2: string, nodeKey: string) => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: h.state.flowNodes[`${flowId}:${nodeKey}`] ?? null,
                    error: null,
                  }),
              }),
            }),
          }),
        }
      }
      if (table === 'flow_run_events') {
        return {
          insert: (row: Record<string, unknown>) => {
            h.state.flowRunEvents.push(row)
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      if (table === 'conversations') {
        return {
          // .update({ ai_debounce_until: null }).lt('ai_debounce_until', cutoff).select(...)
          update: () => ({
            lt: (_col: string, cutoff: string) => ({
              select: () => {
                const matched = h.state.conversations.filter(
                  (c) => c.ai_debounce_until !== null && c.ai_debounce_until < cutoff,
                )
                for (const m of matched) m.ai_debounce_until = null // the UPDATE actually clears it
                return Promise.resolve({
                  data: matched.map(({ id, account_id, contact_id }) => ({
                    id,
                    account_id,
                    contact_id,
                  })),
                  error: null,
                })
              },
            }),
          }),
        }
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: (_col: string, accountId: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: h.state.whatsappConfigs[accountId] ?? null,
                  error: null,
                }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table in cron route test: ${table}`)
    },
  }),
}))

import { GET } from './route'
import { DEBOUNCE_SWEEP_GRACE_SECONDS } from '@/lib/ai/auto-reply'

const SECRET = 'test-cron-secret'

function request(secret: string | null = SECRET): Request {
  const headers = new Headers()
  if (secret !== null) headers.set('x-cron-secret', secret)
  return new Request('http://localhost/api/flows/cron', { headers })
}

/** ISO timestamp `secondsAgo` seconds before now. */
function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString()
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = SECRET
  h.runAutoReplyNow.mockClear()
  h.engineSendText.mockClear()
  h.state.flowRuns = []
  h.state.conversations = []
  h.state.whatsappConfigs = {}
  h.state.flowNodes = {}
  h.state.flowRunEvents = []
})

/** A `flow_runs` row shaped the way the cron route's active-run scan
 *  returns it (nested `flows`/`contacts`), `last_advanced_at`
 *  `ageMinutesAgo` minutes in the past — comfortably under the 24h
 *  default timeout unless a test says otherwise. */
function activeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    flow_id: 'flow-1',
    account_id: 'acct-1',
    user_id: 'user-1',
    contact_id: 'contact-1',
    conversation_id: 'conv-1',
    current_node_key: 'node-1',
    last_advanced_at: secondsAgo(90 * 60), // 90 minutes ago
    last_nudge_sent_at: null,
    flows: { fallback_policy: null }, // resolves to DEFAULT_FALLBACK_POLICY (24h timeout)
    contacts: { ai_nudge_opt_out: false },
    ...overrides,
  }
}

afterEach(() => {
  delete process.env.AUTOMATION_CRON_SECRET
})

describe('GET /api/flows/cron — auth', () => {
  it('401s when the secret header is missing or wrong', async () => {
    const res = await GET(request('wrong-secret'))
    expect(res.status).toBe(401)
    expect(h.runAutoReplyNow).not.toHaveBeenCalled()
  })

  it('503s when AUTOMATION_CRON_SECRET is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const res = await GET(request())
    expect(res.status).toBe(503)
  })
})

describe('GET /api/flows/cron — debounce sweep', () => {
  it('returns zeros and calls nothing when there is nothing to sweep', async () => {
    const res = await GET(request())
    const body = await res.json()
    expect(body).toEqual({ swept: 0, nudged: 0, debounceRecovered: 0 })
    expect(h.runAutoReplyNow).not.toHaveBeenCalled()
  })

  it('recovers a conversation whose debounce window is older than the grace period', async () => {
    h.state.conversations = [
      {
        id: 'conv-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        ai_debounce_until: secondsAgo(DEBOUNCE_SWEEP_GRACE_SECONDS + 30),
      },
    ]
    h.state.whatsappConfigs['acct-1'] = { user_id: 'user-1' }

    const res = await GET(request())
    const body = await res.json()

    expect(h.runAutoReplyNow).toHaveBeenCalledTimes(1)
    expect(h.runAutoReplyNow).toHaveBeenCalledWith({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
      isTextMessage: true,
    })
    expect(body.debounceRecovered).toBe(1)
    // The "owner died mid-sleep" scenario this test simulates: nothing
    // else ever cleared ai_debounce_until until this sweep did.
    expect(h.state.conversations[0].ai_debounce_until).toBeNull()
  })

  it('does NOT touch a conversation whose window is still within the grace period — a live owner may still be working', async () => {
    h.state.conversations = [
      {
        id: 'conv-2',
        account_id: 'acct-1',
        contact_id: 'contact-2',
        // Well within DEBOUNCE_SWEEP_GRACE_SECONDS — e.g. the owner is
        // mid wait/processing-lock, not dead.
        ai_debounce_until: secondsAgo(10),
      },
    ]
    h.state.whatsappConfigs['acct-1'] = { user_id: 'user-1' }

    const res = await GET(request())
    const body = await res.json()

    expect(h.runAutoReplyNow).not.toHaveBeenCalled()
    expect(body.debounceRecovered).toBe(0)
    expect(h.state.conversations[0].ai_debounce_until).not.toBeNull()
  })

  it('skips a conversation with no whatsapp_config for its account, without breaking the rest of the sweep', async () => {
    h.state.conversations = [
      {
        id: 'conv-orphan-account',
        account_id: 'acct-missing-config',
        contact_id: 'contact-1',
        ai_debounce_until: secondsAgo(DEBOUNCE_SWEEP_GRACE_SECONDS + 30),
      },
      {
        id: 'conv-3',
        account_id: 'acct-1',
        contact_id: 'contact-3',
        ai_debounce_until: secondsAgo(DEBOUNCE_SWEEP_GRACE_SECONDS + 30),
      },
    ]
    h.state.whatsappConfigs['acct-1'] = { user_id: 'user-1' }
    // acct-missing-config intentionally has no entry.

    const res = await GET(request())
    const body = await res.json()

    expect(h.runAutoReplyNow).toHaveBeenCalledTimes(1)
    expect(h.runAutoReplyNow).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-3' }),
    )
    expect(body.debounceRecovered).toBe(1)
  })

  it('recovers multiple orphaned conversations across different accounts in one sweep', async () => {
    h.state.conversations = [
      {
        id: 'conv-a',
        account_id: 'acct-a',
        contact_id: 'contact-a',
        ai_debounce_until: secondsAgo(DEBOUNCE_SWEEP_GRACE_SECONDS + 5),
      },
      {
        id: 'conv-b',
        account_id: 'acct-b',
        contact_id: 'contact-b',
        ai_debounce_until: secondsAgo(DEBOUNCE_SWEEP_GRACE_SECONDS + 5),
      },
    ]
    h.state.whatsappConfigs['acct-a'] = { user_id: 'user-a' }
    h.state.whatsappConfigs['acct-b'] = { user_id: 'user-b' }

    const res = await GET(request())
    const body = await res.json()

    expect(h.runAutoReplyNow).toHaveBeenCalledTimes(2)
    expect(body.debounceRecovered).toBe(2)
  })
})

describe('GET /api/flows/cron — inactivity nudge defaults', () => {
  it('send_list node with no nudge_after_minutes configured nudges automatically after DEFAULT_NUDGE_AFTER_MINUTES, with the built-in text', async () => {
    h.state.flowRuns = [activeRun()]
    h.state.flowNodes['flow-1:node-1'] = {
      node_type: 'send_list',
      config: {}, // no nudge_after_minutes / nudge_text — must still default on
    }

    const res = await GET(request())
    const body = await res.json()

    expect(body.nudged).toBe(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        text: '¿Sigues ahí? Quedé esperando tu respuesta para poder continuar con tu consulta.',
      }),
    )
    expect(h.state.flowRuns[0].last_nudge_sent_at).not.toBeNull()
  })

  it('send_buttons node with nudge_after_minutes: 0 opts out of the default — never nudges', async () => {
    h.state.flowRuns = [activeRun()]
    h.state.flowNodes['flow-1:node-1'] = {
      node_type: 'send_buttons',
      config: { nudge_after_minutes: 0 },
    }

    const res = await GET(request())
    const body = await res.json()

    expect(body.nudged).toBe(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('send_list node overrides the default with its own nudge_after_minutes and nudge_text', async () => {
    h.state.flowRuns = [
      activeRun({ last_advanced_at: secondsAgo(20 * 60) }), // 20 min ago
    ]
    h.state.flowNodes['flow-1:node-1'] = {
      node_type: 'send_list',
      config: { nudge_after_minutes: 15, nudge_text: 'Seguimos aquí para ayudarte con tu consulta.' },
    }

    const res = await GET(request())
    const body = await res.json()

    // 20 min of silence already clears the node's own 15-min threshold,
    // even though it's well under the 60-min default.
    expect(body.nudged).toBe(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Seguimos aquí para ayudarte con tu consulta.' }),
    )
  })

  it('collect_ai node with no nudge_after_minutes configured stays silent — collect_ai remains strictly opt-in, unlike send_buttons/send_list', async () => {
    h.state.flowRuns = [activeRun()]
    h.state.flowNodes['flow-1:node-1'] = {
      node_type: 'collect_ai',
      config: {}, // no nudge_after_minutes — no default applies here
    }

    const res = await GET(request())
    const body = await res.json()

    expect(body.nudged).toBe(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('a send_list node still short of the default window does not nudge yet', async () => {
    h.state.flowRuns = [
      activeRun({ last_advanced_at: secondsAgo(10 * 60) }), // only 10 min of silence
    ]
    h.state.flowNodes['flow-1:node-1'] = {
      node_type: 'send_list',
      config: {},
    }

    const res = await GET(request())
    const body = await res.json()

    expect(body.nudged).toBe(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('an opted-out contact never gets the default nudge either', async () => {
    h.state.flowRuns = [activeRun({ contacts: { ai_nudge_opt_out: true } })]
    h.state.flowNodes['flow-1:node-1'] = {
      node_type: 'send_buttons',
      config: {},
    }

    const res = await GET(request())
    const body = await res.json()

    expect(body.nudged).toBe(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})
