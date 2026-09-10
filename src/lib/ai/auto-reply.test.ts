import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
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
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
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
      if (table === 'messages') {
        // .update({ transcript }).eq('id', ...) — writes the transcript
        // back onto the inbound audio row.
        return {
          update: (payload: Record<string, unknown>) => {
            h.state.transcriptUpdate = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
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
          return { eq: () => Promise.resolve({ error: null }) }
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

import { dispatchInboundToAiReply, runAutoReplyNow } from './auto-reply'

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
        text: 'Un asesor va a continuar contigo en breve.',
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

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
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
        text: 'Un asesor va a continuar contigo en breve.',
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
    expect(h.state.rpcCalls).toHaveLength(0) // never calls claim_ai_reply_slot
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
      expect.objectContaining({ text: 'Un asesor va a continuar contigo en breve.' }),
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
        text: 'Un asesor va a continuar contigo en breve.',
      }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Un asesor va a continuar contigo en breve.' }),
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
      expect.objectContaining({ text: 'Un asesor va a continuar contigo en breve.' }),
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
      }),
    )
  })

  it('still respects the reply cap for a live photo — a capped conversation never reaches buildConversationContext', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ visionEnabled: true }))
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3 }
    await dispatchInboundToAiReply(IMAGE_ARGS)
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Un asesor va a continuar contigo en breve.' }),
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
      expect.objectContaining({ text: 'Un asesor va a continuar contigo en breve.' }),
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

  it('a non-text inbound never claims a debounce window', async () => {
    await dispatchInboundToAiReply({ ...ARGS, isTextMessage: false })
    expect(h.state.rpcCalls.some((c) => c.name === 'claim_ai_debounce_window')).toBe(false)
    expect(h.state.debounceUpdates).toHaveLength(0)
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
      expect.objectContaining({ text: 'Un asesor va a continuar contigo en breve.' }),
    )
  })

  it('is NOT appended to the non-text "text only" fallback, even on the first reply', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
    await runAutoReplyNow({ ...ARGS, isTextMessage: false })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?',
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
      expect.objectContaining({ text: 'Un asesor va a continuar contigo en breve.' }),
    )
  })
})
