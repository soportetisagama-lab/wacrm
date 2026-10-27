import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { noteAiKeyFailure, resetAiAvailability } from './availability'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { AiError, type AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  notifyAdmins: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  engineSendMedia: vi.fn(),
  transcribeAudio: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  decrypt: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    waConfig: null as Record<string, unknown> | null,
    transcriptUpdate: null as Record<string, unknown> | null,
    // Debounce (claim_ai_debounce_window + ai_debounce_until bookkeeping) —
    // kept separate from `updatePayload`/`claim` above so every existing
    // assertion on those two keeps meaning exactly what it meant before
    // debounce existed.
    debounceClaim: null as { is_owner: boolean; wait_until: string } | null,
    debounceClaimError: null as { message: string } | null,
    // Values returned by successive `.select('ai_debounce_until')` reads
    // inside the recheck loop, one per call; an empty/exhausted queue
    // reads back as "no active window" (settles immediately).
    debounceRecheckQueue: [] as (string | null)[],
    debounceUpdates: [] as Record<string, unknown>[],
    // Customer rows newest-first, read by summarizePendingBurst; null
    // makes that read fail (callers then fall back to their own message).
    burstRows: null as Record<string, unknown>[] | null,
    // The latest business message, read by lastBusinessMessageIs.
    lastBusinessRows: [] as Record<string, unknown>[],
    contactName: null as string | null,
    // account_role of the handoff target (profiles lookup in assignee-guard).
    profileRole: null as string | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./business-info', () => ({ loadBusinessInfo: async () => null }))
vi.mock('@/lib/line-transfer-inbound', () => ({ loadLineTransferContext: async () => null }))
vi.mock('@/lib/line-transfer-outbound', () => ({ loadOutboundTransferContext: async () => null }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
// The advisor brief has its own model call + context read (tested in
// handoff-brief.test.ts); stubbed so these tests keep asserting on the
// reply path alone.
vi.mock('./handoff-brief', () => ({ writeHandoffBrief: async () => {} }))
vi.mock('./availability-notify', () => ({ notifyAdminsAiUnavailable: h.notifyAdmins }))
vi.mock('./transcribe', () => ({ transcribeAudio: h.transcribeAudio }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendMedia: h.engineSendMedia,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: h.decrypt }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'whatsapp_config') {
        // .select().eq().single() → decrypted access_token source
        const chain = {
          select: () => chain,
          eq: () => chain,
          single: () =>
            Promise.resolve({
              data: h.state.waConfig,
              error: h.state.waConfig ? null : { message: 'not found' },
            }),
        }
        return chain
      }
      if (table === 'profiles') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: h.state.profileRole ? { account_role: h.state.profileRole } : null,
              error: null,
            }),
        }
        return chain
      }
      if (table === 'contacts') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: { name: h.state.contactName }, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        // .update({ transcript }).eq('id', ...) — writes the transcript
        // back onto the inbound audio row. select() chains serve the
        // burst summary and the "last business message" check.
        let businessOnly = false
        let humanReplyLookup = false
        const chain = {
          select: () => chain,
          eq: () => chain,
          neq: () => {
            businessOnly = true
            return chain
          },
          // hasRecentHumanReply — no human replies in these tests.
          gte: () => {
            humanReplyLookup = true
            return chain
          },
          order: () => chain,
          limit: () =>
            Promise.resolve(
              humanReplyLookup
                ? { data: [], error: null }
                : businessOnly
                ? { data: h.state.lastBusinessRows, error: null }
                : h.state.burstRows
                  ? { data: h.state.burstRows, error: null }
                  : { data: null, error: { message: 'no rows' } },
            ),
          update: (payload: Record<string, unknown>) => {
            h.state.transcriptUpdate = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
        return chain
      }
      // conversations
      return {
        select: (cols?: string) => ({
          eq: () => ({
            maybeSingle: () => {
              // The debounce recheck loop only ever selects this exact
              // column — distinguish it from the eligibility-gate select
              // (`assigned_agent_id, ai_autoreply_disabled, ai_reply_count`)
              // so both can be driven independently from the same fake.
              if (cols === 'ai_debounce_until') {
                const next = h.state.debounceRecheckQueue.shift() ?? null
                return Promise.resolve({
                  data: next ? { ai_debounce_until: next } : null,
                  error: null,
                })
              }
              return Promise.resolve({ data: h.state.conv, error: null })
            },
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          if ('ai_debounce_until' in payload) {
            h.state.debounceUpdates.push(payload)
          } else {
            h.state.updatePayload = payload
          }
          const done = Promise.resolve({ error: null })
          return { eq: () => Object.assign(done, { lte: () => done }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      if (name === 'claim_ai_debounce_window') {
        return Promise.resolve({
          data: h.state.debounceClaim ? [h.state.debounceClaim] : [],
          error: h.state.debounceClaimError,
        })
      }
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import {
  dispatchInboundToAiReply,
  endsWithRepeatedAiReply,
  handoffClosingText,
  runAutoReplyForOrphanedWindow,
  runAutoReplyForPendingBurst,
  runAutoReplyNow,
} from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  isTextMessage: true,
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    transcribeAudioEnabled: false,
    visionEnabled: false,
    documents: [],
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    // Not the conversation's first reply by default — keeps every
    // existing "exact sent text" assertion below unaffected by the
    // FIRST_REPLY_MENU_HINT footer, which only appends when this is 0.
    // The dedicated "first-reply menu footer" describe block below sets
    // this to 0 explicitly to test that behavior.
    ai_reply_count: 1,
  }
  h.state.autoResponders = []
  h.state.profileRole = null
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.waConfig = { access_token: 'enc-token' }
  h.state.transcriptUpdate = null
  // Default: this message is the only one — already-past wait_until so
  // the debounce wrapper settles immediately and every existing
  // assertion below keeps testing the same "single message" behavior it
  // always did.
  h.state.debounceClaim = {
    is_owner: true,
    wait_until: new Date(Date.now() - 1000).toISOString(),
  }
  h.state.debounceClaimError = null
  h.state.debounceRecheckQueue = []
  h.state.debounceUpdates = []
  h.state.burstRows = null
  h.state.lastBusinessRows = []
  h.state.contactName = null
  // Every test answers from the same account — keep the per-account
  // throttle from tripping as the suite grows.
  __resetRateLimitForTests()
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: 'm-media' })
  h.transcribeAudio.mockResolvedValue({ text: 'quiero cotizar dos cocinas', durationSeconds: 4 })
  h.getMediaUrl.mockResolvedValue({ url: 'https://meta.example/audio.ogg', mimeType: 'audio/ogg' })
  h.downloadMedia.mockResolvedValue({ buffer: Buffer.from('bytes'), contentType: 'audio/ogg' })
  h.decrypt.mockImplementation((v: string) => `plain:${v}`)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_debounce_window',
        args: { p_conversation_id: 'conv-1', p_window_seconds: 6 },
      },
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    // The processing lock + final clear are debounce bookkeeping, tracked
    // separately from the business-logic `updatePayload` assertions below.
    expect(h.state.debounceUpdates).toHaveLength(2)
    expect(h.state.debounceUpdates[1]).toEqual({ ai_debounce_until: null })
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('sends a closing line and marks the conversation when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim; the model's generated text is
    // discarded, but the customer still gets a closing line instead of
    // silence. rpcCalls[0] is the debounce claim (every text inbound
    // makes that one first); rpcCalls[1] is the reply-slot claim this
    // test is actually about.
    expect(h.state.rpcCalls).toHaveLength(2)
    expect(h.state.rpcCalls[1].name).toBe('claim_ai_reply_slot')
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: expect.stringMatching(/asesor del equipo/),
      }),
    )
    expect(h.engineSendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toBe(
      '🤖 Se alcanzó el límite de 3 respuestas automáticas por conversación.',
    )
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('resumes when auto-reply was disabled on this conversation but nobody has claimed it and the cap was not the reason (ai_reply_count below the cap)', async () => {
    // A prior handoff (model-decided or Flow-side) set ai_autoreply_disabled,
    // but no agent ever picked it up — must not strand the customer.
    // See the "menú"/reopen work: this mirrors isConversationBotEligible's
    // own relaxation on the Flows side.
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 1,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('still blocks when ai_autoreply_disabled AND ai_reply_count is at/over the cap — the cap-reached event itself must not resend its closing line on every new message', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 3, // === the default autoReplyMaxPerConversation
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('still blocks unconditionally once a human agent has actually claimed the thread, regardless of ai_reply_count', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('sends a closing line and marks the conversation when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    // Never even calls the provider — this is the cheap pre-check,
    // before generateReply.
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: expect.stringMatching(/asesor del equipo/),
      }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toBe(
      '🤖 Se alcanzó el límite de 3 respuestas automáticas por conversación.',
    )
    // No handoff target configured → conversation left unassigned,
    // same convention as a model-decided handoff.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes the cap-reached handoff to the configured agent, same as a model handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('does not route a WhatsApp handoff to a Community Manager, but still hands off', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'cm-1' }))
    h.state.profileRole = 'community_manager'
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      channel: 'whatsapp',
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes an Instagram handoff to a Community Manager', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'cm-1' }))
    h.state.profileRole = 'community_manager'
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      channel: 'instagram',
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ assigned_agent_id: 'cm-1' })
  })

  it('a second capped inbound sends nothing further — ai_autoreply_disabled already true short-circuits it first', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true, // as if the first capped message already set this
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('the cap-reached note reflects the account\'s actual configured max, not a hardcoded number', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyMaxPerConversation: 5 }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 5,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload?.ai_handoff_summary).toBe(
      '🤖 Se alcanzó el límite de 5 respuestas automáticas por conversación.',
    )
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — non-text inbound (image/video/audio/sticker/document)', () => {
  it('sends the fixed "text only" nudge without ever calling the provider or claiming a reply slot', async () => {
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    // never calls claim_ai_reply_slot (only the debounce claim)
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual(['claim_ai_debounce_window'])
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('does not touch ai_autoreply_disabled/ai_handoff_summary — this is not a handoff', async () => {
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.state.updatePayload).toBeNull()
  })

  it('still respects the existing eligibility gates — e.g. stays silent when AI is off', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('still respects the reply cap — a capped conversation gets the cap handoff, not the text-only nudge', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('sends the closing line, disables auto-reply, and writes a summary on handoff — never the (empty) generated text', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    // The prompt instructs the model to reply with exactly [[HANDOFF]]
    // and nothing else, so `text` is always empty here — the customer
    // must still get the fixed closing line, not silence, and never
    // the raw (empty) generated text via the normal send path. Only the
    // debounce claim runs here — a model-decided handoff exits before
    // ever reaching claim_ai_reply_slot.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0].name).toBe('claim_ai_debounce_window')
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: expect.stringMatching(/asesor del equipo/),
      }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('hands off instead of going silent when the model returns an empty response', async () => {
    h.generateReply.mockRejectedValue(
      new AiError('OpenAI returned an empty response.', { code: 'empty_response' }),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/asesor del equipo/),
      }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('still marks the conversation for handoff even if the closing-message send fails', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.engineSendText.mockRejectedValue(new Error('meta send failed'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })
})

describe('dispatchInboundToAiReply — AI unavailable (no credit / rejected key / outage)', () => {
  afterEach(() => resetAiAvailability())

  it('hands off instead of going silent when the provider call fails', async () => {
    h.generateReply.mockRejectedValue(
      new AiError('OpenAI account has no credit left', { code: 'no_credit' }),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
    expect(h.state.updatePayload).toMatchObject({ status: 'pending', ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toBe('🤖 El asistente derivó la conversación a un asesor.')
    // The reason is for admins only — never in the agent-visible note.
    expect(h.state.updatePayload?.ai_handoff_summary).not.toMatch(/saldo|clave|credit/i)
    expect(h.notifyAdmins).toHaveBeenCalledWith(expect.anything(), 'acct-1')
  })

  it('a timeout or outage hands off the same way', async () => {
    h.generateReply.mockRejectedValue(new AiError('took too long', { code: 'timeout' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    // Transient — not a "recharge the account" situation, no admin push.
    expect(h.notifyAdmins).not.toHaveBeenCalled()
  })

  it('stays quiet on a conversation already handed off and still waiting for a human — no repeated closing line', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: true, ai_reply_count: 1 }
    h.generateReply.mockRejectedValue(new AiError('no credit', { code: 'no_credit' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('while the key is paused, hands off without calling the provider at all', async () => {
    noteAiKeyFailure(aiConfig().apiKey, new AiError('no credit', { code: 'no_credit' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('while paused, a media inbound is handed off too — no text-only nudge or transcription attempt', async () => {
    noteAiKeyFailure(aiConfig().apiKey, new AiError('no credit', { code: 'no_credit' }))
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.transcribeAudio).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
  })
})

describe('dispatchInboundToAiReply — audio transcription', () => {
  const AUDIO_ARGS = {
    ...ARGS,
    isTextMessage: false,
    audio: { mediaId: 'media-1', mimeType: 'audio/ogg', messageDbId: 'msg-1' },
  }

  it('falls back to the text-only nudge when transcribe_audio_enabled is off — never calls transcribeAudio', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: false, embeddingsApiKey: 'sk-embed' }),
    )
    await dispatchInboundToAiReply(AUDIO_ARGS)
    expect(h.transcribeAudio).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('falls back the same way when enabled but there is no embeddings key — treated as disabled, not an error', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: null }),
    )
    await dispatchInboundToAiReply(AUDIO_ARGS)
    expect(h.transcribeAudio).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('never attempts transcription for non-audio media, even with the feature on — no `audio` field means no transcript', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.transcribeAudio).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('on success: downloads with the account access token, transcribes with the embeddings key, persists the transcript, and continues to the normal reply', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    await dispatchInboundToAiReply(AUDIO_ARGS)

    expect(h.getMediaUrl).toHaveBeenCalledWith({ mediaId: 'media-1', accessToken: 'plain:enc-token' })
    expect(h.downloadMedia).toHaveBeenCalledWith({
      downloadUrl: 'https://meta.example/audio.ogg',
      accessToken: 'plain:enc-token',
    })
    expect(h.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-embed', mimeType: 'audio/ogg' }),
    )
    expect(h.state.transcriptUpdate).toEqual({ transcript: 'quiero cotizar dos cocinas' })

    // Falls through to the normal text path — buildConversationContext,
    // generateReply and the real send all run, same as any text inbound.
    expect(h.buildConversationContext).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('an empty transcription (silence) still gets persisted but falls back to the text-only nudge, not the normal reply path', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    h.transcribeAudio.mockResolvedValue({ text: '', durationSeconds: 1 })
    await dispatchInboundToAiReply(AUDIO_ARGS)

    expect(h.state.transcriptUpdate).toEqual({ transcript: '' })
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('a whitespace-only transcription is also treated as empty', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    h.transcribeAudio.mockResolvedValue({ text: '   ', durationSeconds: 1 })
    await dispatchInboundToAiReply(AUDIO_ARGS)
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('a transcription failure falls back to the text-only nudge and persists nothing', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    h.transcribeAudio.mockRejectedValue(new Error('Whisper rejected the file'))
    await dispatchInboundToAiReply(AUDIO_ARGS)

    expect(h.state.transcriptUpdate).toBeNull()
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('a download failure (getMediaUrl/downloadMedia) falls back the same way and never calls transcribeAudio', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    h.getMediaUrl.mockRejectedValue(new Error('Meta media fetch failed'))
    await dispatchInboundToAiReply(AUDIO_ARGS)

    expect(h.transcribeAudio).not.toHaveBeenCalled()
    expect(h.state.transcriptUpdate).toBeNull()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('a missing whatsapp_config falls back the same way, without ever calling transcribeAudio', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    h.state.waConfig = null
    await dispatchInboundToAiReply(AUDIO_ARGS)

    expect(h.getMediaUrl).not.toHaveBeenCalled()
    expect(h.transcribeAudio).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('still respects the reply cap for audio — a capped conversation never even attempts transcription', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ transcribeAudioEnabled: true, embeddingsApiKey: 'sk-embed' }),
    )
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(AUDIO_ARGS)
    expect(h.transcribeAudio).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
  })
})

describe('dispatchInboundToAiReply — vision fallthrough', () => {
  const IMAGE_ARGS = { ...ARGS, isTextMessage: false, isImageMessage: true }

  it('always passes includeImages to buildConversationContext, matching visionEnabled', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }))
    await dispatchInboundToAiReply(ARGS) // a plain text turn, not an image
    expect(h.buildConversationContext).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      undefined,
      { includeImages: true },
    )
  })

  it('falls back to the text-only nudge when visionEnabled is off, even for a live inbound photo', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: false }))
    await dispatchInboundToAiReply(IMAGE_ARGS)
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('falls through to the normal reply path for a live inbound photo when visionEnabled is on', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }))
    await dispatchInboundToAiReply(IMAGE_ARGS)
    expect(h.buildConversationContext).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      undefined,
      { includeImages: true },
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('never treats a non-image media inbound as a vision fallthrough, even with visionEnabled on', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }))
    // isImageMessage absent — e.g. a video/document/sticker inbound.
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('still respects the reply cap for a live photo — a capped conversation never reaches buildConversationContext', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }))
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3 }
    await dispatchInboundToAiReply(IMAGE_ARGS)
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
  })
})

describe('dispatchInboundToAiReply — document send (Opción B)', () => {
  const CATALOGO = {
    key: 'catalogo',
    label: 'Catálogo de productos',
    media_type: 'document' as const,
    media_url: 'https://storage.example/catalogo.pdf',
    filename: 'catalogo.pdf',
  }

  it('sends the matching document via engineSendMedia when generateReply returns sendDocument, alongside the normal reply', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ documents: [CATALOGO] }))
    h.generateReply.mockResolvedValue({
      text: '¡Acá tienes!',
      handoff: false,
      sendDocument: 'catalogo',
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'document',
        link: 'https://storage.example/catalogo.pdf',
        filename: 'catalogo.pdf',
      }),
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: '¡Acá tienes!' }),
    )
  })

  it('never calls engineSendMedia when generateReply returns no sendDocument', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ documents: [CATALOGO] }))
    h.generateReply.mockResolvedValue({ text: 'Hola!', handoff: false, sendDocument: null })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendMedia).not.toHaveBeenCalled()
  })

  it('skips the send (without throwing) when the key no longer matches any configured document', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ documents: [] }))
    h.generateReply.mockResolvedValue({
      text: '¡Acá tienes!',
      handoff: false,
      sendDocument: 'catalogo',
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendMedia).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: '¡Acá tienes!' }),
    )
  })

  it('sends the document even on a turn that also ends in handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ documents: [CATALOGO] }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true, sendDocument: 'catalogo' })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'document', link: 'https://storage.example/catalogo.pdf' }),
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
  })

  it('a failed document send is logged but the normal reply still goes out', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ documents: [CATALOGO] }))
    h.generateReply.mockResolvedValue({
      text: '¡Acá tienes!',
      handoff: false,
      sendDocument: 'catalogo',
    })
    h.engineSendMedia.mockRejectedValue(new Error('Meta rejected the media'))

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: '¡Acá tienes!' }),
    )
  })
})

describe('dispatchInboundToAiReply — debounce', () => {
  it('a follower (is_owner: false) returns immediately without touching gates, the provider, or claim_ai_reply_slot', async () => {
    h.state.debounceClaim = { is_owner: false, wait_until: new Date(Date.now() + 6000).toISOString() }
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAiConfig).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_debounce_window',
        args: { p_conversation_id: 'conv-1', p_window_seconds: 6 },
      },
    ])
    // A follower never became the owner — it must not clear a window some
    // OTHER, still-active owner is mid-way through.
    expect(h.state.debounceUpdates).toHaveLength(0)
  })

  it('the owner waits out an extension the recheck loop observes, then proceeds', async () => {
    // First recheck sees a still-future value (a follower extended the
    // window); second recheck sees it already elapsed → settles.
    h.state.debounceRecheckQueue = [new Date(Date.now() + 5).toISOString(), null]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
    expect(h.state.debounceRecheckQueue).toHaveLength(0) // both reads consumed
  })

  it('a claim_ai_debounce_window error fails OPEN to the immediate path instead of dropping the reply', async () => {
    h.state.debounceClaim = null
    h.state.debounceClaimError = { message: 'function not found' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
    // Fell through to the immediate path — never reached the
    // processing-lock/clear bookkeeping, since no window was ever claimed.
    expect(h.state.debounceUpdates).toHaveLength(0)
  })

  it('clears ai_debounce_until even when an eligibility gate blocks the send (not just on the happy path)', async () => {
    h.loadAiConfig.mockResolvedValue(null) // AI off — runAutoReplyNow no-ops
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.debounceUpdates.at(-1)).toEqual({ ai_debounce_until: null })
  })

  it('a non-text inbound joins the burst too — a follower photo sends nothing itself', async () => {
    h.state.debounceClaim = { is_owner: false, wait_until: new Date(Date.now() + 6000).toISOString() }
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false, isImageMessage: true })
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual(['claim_ai_debounce_window'])
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('a media owner whose burst also carries text answers it as text, not with the file notice', async () => {
    const now = new Date().toISOString()
    h.state.burstRows = [
      { sender_type: 'customer', content_type: 'text', content_text: '¿cuánto cuesta esto?', created_at: now },
      { sender_type: 'customer', content_type: 'document', content_text: null, created_at: now },
      { sender_type: 'bot', content_type: 'text', content_text: 'Hola', created_at: now },
    ]
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello!' }))
  })

  it('sends the file notice once per batch — not again when it was the last thing sent', async () => {
    h.state.lastBusinessRows = [
      {
        content_text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
        created_at: new Date().toISOString(),
      },
    ]
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('answers again when a message arrived while the reply was being written, instead of dropping it', async () => {
    // Recheck after the first answer: the window grew past the processing
    // lock (a follower landed meanwhile); after the second answer it's clear.
    h.state.debounceRecheckQueue = []
    let reads = 0
    h.generateReply.mockImplementation(async () => {
      reads += 1
      if (reads === 1) {
        h.state.debounceRecheckQueue.push(new Date(Date.now() + 60_000).toISOString(), null)
      }
      return { text: 'Hello!', handoff: false }
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const p = dispatchInboundToAiReply(ARGS)
      await vi.advanceTimersByTimeAsync(20_000)
      await p
    } finally {
      vi.useRealTimers()
    }
    expect(h.generateReply).toHaveBeenCalledTimes(2)
  })

  // The previous turn's own reply is the newest message by the time the
  // rerun reads the burst: the text that arrived during it must still
  // be answered as text — never with the file notice — and only once.
  async function runWithFollowerDuringReply(followerText: string | null) {
    h.state.debounceRecheckQueue = []
    h.state.burstRows = [
      { sender_type: 'customer', content_type: 'text', content_text: 'quiero una mesa', created_at: new Date(Date.now() - 4000).toISOString() },
    ]
    let calls = 0
    h.generateReply.mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        const rows: Record<string, unknown>[] = []
        if (followerText) {
          rows.push({ sender_type: 'customer', content_type: 'text', content_text: followerText, created_at: new Date(Date.now()).toISOString() })
        }
        rows.unshift({ sender_type: 'bot', content_type: 'text', content_text: 'Hello!', created_at: new Date(Date.now() + 1).toISOString() })
        h.state.burstRows = [...rows, ...(h.state.burstRows ?? [])]
        h.state.debounceRecheckQueue.push(new Date(Date.now() + 60_000).toISOString(), null)
      }
      return { text: calls === 1 ? 'Hello!' : 'Sí, también en acero.', handoff: false }
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const p = dispatchInboundToAiReply(ARGS)
      await vi.advanceTimersByTimeAsync(20_000)
      await p
    } finally {
      vi.useRealTimers()
    }
  }

  it('a text that arrived during the reply is answered on the rerun as text, not with the file notice', async () => {
    await runWithFollowerDuringReply('y también en acero')
    expect(h.generateReply).toHaveBeenCalledTimes(2)
    const sent = h.engineSendText.mock.calls.map((c) => (c[0] as { text: string }).text)
    expect(sent).toEqual(['Hello!', 'Sí, también en acero.'])
  })

  it('a rerun with nothing new since the previous turn started answers nothing (no double reply)', async () => {
    await runWithFollowerDuringReply(null)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('respects the hard wait cap instead of waiting forever on repeated extensions', async () => {
    vi.useFakeTimers()
    try {
      // wait_until already due, but the recheck queue keeps reporting a
      // fresh future extension every time — without a hard cap this would
      // never settle.
      h.state.debounceRecheckQueue = Array.from({ length: 50 }, () =>
        new Date(Date.now() + 5000).toISOString(),
      )
      const p = dispatchInboundToAiReply(ARGS)
      // Advance well past MAX_DEBOUNCE_WAIT_SECONDS (15s) worth of sleeps.
      await vi.advanceTimersByTimeAsync(20_000)
      await p
      expect(h.engineSendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hello!' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runAutoReplyForPendingBurst / runAutoReplyForOrphanedWindow', () => {
  const BASE = { accountId: 'acct-1', conversationId: 'conv-1', contactId: 'contact-1', configOwnerUserId: 'user-1' }

  it('pending burst: answers what arrived since the given moment, as text', async () => {
    const since = Date.now() - 3000
    h.state.burstRows = [
      { sender_type: 'bot', content_type: 'text', content_text: 'Listo, un asesor te contactará.', created_at: new Date().toISOString() },
      { sender_type: 'customer', content_type: 'text', content_text: 'y en acero', created_at: new Date(Date.now() - 1000).toISOString() },
    ]
    await runAutoReplyForPendingBurst(BASE, since)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello!' }))
  })

  it('pending burst: nothing since that moment → sends nothing', async () => {
    h.state.burstRows = [
      { sender_type: 'bot', content_type: 'text', content_text: 'Hola', created_at: new Date().toISOString() },
      { sender_type: 'customer', content_type: 'text', content_text: 'hola', created_at: new Date(Date.now() - 9000).toISOString() },
    ]
    await runAutoReplyForPendingBurst(BASE, Date.now() - 3000)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('cron sweep: the bot replied last but a text arrived during that reply → answered as text, not the file notice', async () => {
    h.state.burstRows = [
      { sender_type: 'bot', content_type: 'text', content_text: 'Hola', created_at: new Date().toISOString() },
      { sender_type: 'customer', content_type: 'text', content_text: 'y en acero', created_at: new Date(Date.now() - 2000).toISOString() },
    ]
    await runAutoReplyForOrphanedWindow(BASE)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello!' }))
  })

  it('cron sweep: nothing pending → sends nothing', async () => {
    h.state.burstRows = [
      { sender_type: 'bot', content_type: 'text', content_text: 'Hola', created_at: new Date().toISOString() },
      { sender_type: 'customer', content_type: 'text', content_text: 'hola', created_at: new Date(Date.now() - 120_000).toISOString() },
    ]
    await runAutoReplyForOrphanedWindow(BASE)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('runAutoReplyNow — called directly (mirrors the cron sweep call site)', () => {
  it('behaves identically to the debounced happy path, with no debounce bookkeeping at all', async () => {
    await runAutoReplyNow(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.state.debounceUpdates).toHaveLength(0)
  })
})

describe('runAutoReplyNow — first-reply menu footer', () => {
  const FOOTER = '\n\nSi quieres ver todas nuestras opciones, escribe menú.'

  it('appends the footer when this is the conversation\'s first reply (ai_reply_count === 0)', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
    await runAutoReplyNow(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: `Hello!${FOOTER}` }),
    )
  })

  it('does NOT append the footer on a later reply (ai_reply_count > 0)', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 1 }
    await runAutoReplyNow(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('does NOT duplicate the hint when the model already mentions menú/menu on its own', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
    h.generateReply.mockResolvedValue({
      text: 'Atendemos de lunes a viernes. Escribe *menú* para ver las opciones otra vez.',
      handoff: false,
    })
    await runAutoReplyNow(ARGS)
    const sentText = h.engineSendText.mock.calls[0][0].text as string
    expect(sentText).toBe('Atendemos de lunes a viernes. Escribe *menú* para ver las opciones otra vez.')
    expect(sentText.match(/men[uú]/gi)).toHaveLength(1)
  })

  it('is deterministic, not model-generated — the model\'s own text never contains it', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
    h.generateReply.mockResolvedValue({ text: 'Claro, te ayudo con eso.', handoff: false })
    await runAutoReplyNow(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: `Claro, te ayudo con eso.${FOOTER}` }),
    )
  })

  it('is NOT appended to the handoff closing line, even on the first reply', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await runAutoReplyNow(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
  })

  it('is NOT appended to the non-text "text only" fallback, even on the first reply', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
    await runAutoReplyNow({ ...ARGS, isTextMessage: false })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recibí tu archivo. ¿Me cuentas en un mensaje qué necesitas?',
      }),
    )
  })

  it('is NOT appended when the cap-reached closing line fires, even with ai_reply_count still 0 (lost the atomic claim race)', async () => {
    // ai_reply_count === 0 clears the cheap pre-check, but the atomic
    // claim_ai_reply_slot race is lost (a concurrent inbound took the
    // last slot) — handleAutoReplyCapReached sends the fixed closing
    // line, never reaching the footer-append site at the bottom of the
    // happy path.
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
    h.state.claim = false
    await runAutoReplyNow(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/asesor del equipo/) }),
    )
  })
})

// Reference dates as in flows/business-hours.test.ts: Mon 2024-01-01, UTC = Peru + 5h.
describe('handoffClosingText', () => {
  it('within hours promises the advisor "en breve"', () => {
    expect(handoffClosingText(new Date('2024-01-02T15:00:00Z'))).toBe(
      'Listo, ya le paso tu caso a un asesor del equipo y te escribe por aquí en breve 👍',
    )
  })

  it('after hours says when an advisor will actually write', () => {
    expect(handoffClosingText(new Date('2024-01-03T02:00:00Z'))).toBe(
      'Listo, ya le paso tu caso a un asesor del equipo 👍 Ahora estamos fuera de horario, así que te escribe por aquí mañana a las 8:00 am.',
    )
  })

  it('on Saturday afternoon points to Monday', () => {
    expect(handoffClosingText(new Date('2024-01-06T20:00:00Z'))).toMatch(/el lunes a las 8:00 am\.$/)
  })
})

describe('handoffClosingText — variants and complaints', () => {
  it('every variant still names the advisor; the complaint wording apologizes without an emoji', () => {
    const at = new Date('2024-01-02T15:00:00Z')
    for (let v = 0; v < 6; v++) {
      expect(handoffClosingText(at, { variant: v })).toMatch(/asesor del equipo/)
      const complaint = handoffClosingText(at, { complaint: true, variant: v })
      expect(complaint).toMatch(/Lamento|lo siento/)
      expect(complaint).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})

describe('runAutoReplyNow — handoff closing once, complaints, documents, prompt facts', () => {
  it('a thread already handed off (bot re-opened, nobody claimed it) is not told again that an advisor is coming', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: true, ai_reply_count: 1 }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await runAutoReplyNow(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('a complaint gets the apologetic closing line, without an emoji', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Pésimo servicio, el pedido llegó roto' },
    ])
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await runAutoReplyNow(ARGS)
    const sent = h.engineSendText.mock.calls[0][0].text as string
    expect(sent).toMatch(/Lamento|lo siento/)
    expect(sent).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('a turn that only sends a document is not a handoff', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({
        documents: [
          {
            key: 'catalogo',
            label: 'Catálogo',
            media_type: 'document',
            media_url: 'https://storage.example/catalogo.pdf',
          },
        ],
      }),
    )
    h.generateReply.mockResolvedValue({ text: '', handoff: false, sendDocument: 'catalogo' })
    await runAutoReplyNow(ARGS)
    expect(h.engineSendMedia).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('passes the contact name and the current Peru date/time to the prompt', async () => {
    h.state.contactName = 'María Pérez'
    await runAutoReplyNow(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('María Pérez')
    expect(systemPrompt).toContain('Current date and time in Peru:')
  })

  it('queries the knowledge base with the last customer messages, not only the last one', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Necesito una mesa de trabajo' },
      { role: 'assistant', content: '¿De qué medida?' },
      { role: 'user', content: '¿y en acero?' },
    ])
    await runAutoReplyNow(ARGS)
    expect(h.retrieveKnowledge.mock.calls[0][3]).toBe('Necesito una mesa de trabajo\n¿y en acero?')
  })
})

describe('endsWithRepeatedAiReply', () => {
  const ai = (t: string) => ({ sender_type: 'bot', ai_generated: true, content_text: t })
  it('detects three identical AI replies in a row', () => {
    expect(endsWithRepeatedAiReply([ai('x'), ai('x'), ai('x'), ai('y')])).toBe(true)
  })
  it('ignores customer messages in between', () => {
    const c = { sender_type: 'customer', ai_generated: null, content_text: 'audio' }
    expect(endsWithRepeatedAiReply([ai('x'), c, ai('x'), c, ai('x')])).toBe(true)
  })
  it('does not trigger below three or when a different reply breaks the run', () => {
    expect(endsWithRepeatedAiReply([ai('x'), ai('x')])).toBe(false)
    expect(endsWithRepeatedAiReply([ai('x'), ai('y'), ai('x')])).toBe(false)
  })
  it('does not trigger for human or flow messages', () => {
    const h = { sender_type: 'agent', ai_generated: false, content_text: 'x' }
    expect(endsWithRepeatedAiReply([h, h, h])).toBe(false)
  })
})
