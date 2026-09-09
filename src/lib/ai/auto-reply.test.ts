import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
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
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./transcribe', () => ({ transcribeAudio: h.transcribeAudio }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
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
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

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
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.waConfig = { access_token: 'enc-token' }
  h.state.transcriptUpdate = null
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
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
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
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
    // silence.
    expect(h.state.rpcCalls).toHaveLength(1)
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
    // the raw (empty) generated text via the normal send path.
    expect(h.state.rpcCalls).toHaveLength(0)
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
