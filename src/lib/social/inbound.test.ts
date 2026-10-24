import { beforeEach, describe, expect, it, vi } from 'vitest'

// Everything the bot pipeline would call is mocked: these tests cover
// what the inbound processor itself decides (account, dedupe, contact,
// conversation, message row, menu mapping, fallback handoff).
const dispatchInboundToFlows = vi.fn()
const engineSendText = vi.fn()
const dispatchInboundToAiReply = vi.fn()
const routeAcknowledgement = vi.fn()

vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: (a: unknown) => dispatchInboundToFlows(a),
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: (a: unknown) => engineSendText(a) }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: (a: unknown) => dispatchInboundToAiReply(a) }))
vi.mock('@/lib/conversations/acknowledgement', () => ({ routeAcknowledgement: (a: unknown) => routeAcknowledgement(a) }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => undefined }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: async () => undefined }))
vi.mock('@/lib/notifications/push-send', () => ({ sendPushToUser: async () => undefined }))
vi.mock('./graph', () => ({
  fetchSocialProfile: async () => ({ name: 'Ana Pérez', username: 'ana.p', avatarUrl: null }),
}))

import { fakeDb } from '@/lib/ai/learning/fake-db.testutil'
import { encrypt } from '@/lib/whatsapp/encryption'
import { claimInboundEvent, processSocialEvent, SOCIAL_FALLBACK_HANDOFF_TEXT } from './inbound'
import type { SocialInboundEvent } from './parse'

const ACCOUNT = 'acct-1'

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-ig',
    account_id: ACCOUNT,
    user_id: 'admin-1',
    channel: 'instagram',
    external_id: 'IG-1',
    page_id: 'PAGE-1',
    access_token: encrypt('page-token'),
    display_name: 'Sagama',
    username: 'sagama',
    enabled: true,
    show_to_agents: false,
    ...overrides,
  }
}

function event(overrides: Partial<SocialInboundEvent> = {}): SocialInboundEvent {
  return {
    channel: 'instagram',
    externalId: 'IG-1',
    senderId: 'IGSID-9',
    mid: 'mid-1',
    timestamp: Date.parse('2026-10-24T10:00:00Z'),
    kind: 'message',
    text: 'Hola, quiero una cotización',
    attachments: [],
    replyPayload: null,
    replyToMid: null,
    referral: null,
    unsupported: false,
    ...overrides,
  }
}

beforeEach(() => {
  dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  routeAcknowledgement.mockResolvedValue(null)
  dispatchInboundToAiReply.mockResolvedValue(undefined)
  engineSendText.mockResolvedValue({ whatsapp_message_id: 'm-out' })
})

describe('claimInboundEvent', () => {
  it('claims a mid once; a redelivery is refused', async () => {
    const { db } = fakeDb()
    expect(await claimInboundEvent(db, 'instagram', 'mid-1', ACCOUNT)).toBe(true)
    expect(await claimInboundEvent(db, 'instagram', 'mid-1', ACCOUNT)).toBe(false)
    // Same mid on the other network is a different message.
    expect(await claimInboundEvent(db, 'messenger', 'mid-1', ACCOUNT)).toBe(true)
  })
})

describe('processSocialEvent', () => {
  it('creates a phone-less contact keyed by IGSID, its conversation and the message', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [config()] })
    await processSocialEvent(db, event())

    expect(tables.contacts).toHaveLength(1)
    expect(tables.contacts[0]).toMatchObject({
      account_id: ACCOUNT,
      phone: null,
      channel: 'instagram',
      channel_user_id: 'IGSID-9',
      channel_username: 'ana.p',
      name: 'Ana Pérez',
    })
    expect(tables.conversations).toHaveLength(1)
    expect(tables.conversations[0]).toMatchObject({ channel: 'instagram', contact_id: tables.contacts[0].id })
    const customerMsgs = tables.messages.filter((m) => m.sender_type === 'customer')
    expect(customerMsgs).toHaveLength(1)
    expect(customerMsgs[0]).toMatchObject({ content_type: 'text', message_id: 'mid-1', content_text: 'Hola, quiero una cotización' })
    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate a message Meta delivers twice', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [config()] })
    await processSocialEvent(db, event())
    await processSocialEvent(db, event())
    expect(tables.messages.filter((m) => m.sender_type === 'customer')).toHaveLength(1)
    expect(tables.contacts).toHaveLength(1)
    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })

  it('ignores events for pages/accounts that are not configured or disabled', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [config({ enabled: false })] })
    await processSocialEvent(db, event())
    await processSocialEvent(db, event({ externalId: 'OTHER' }))
    expect(tables.messages ?? []).toHaveLength(0)
  })

  it('maps a typed number back to the menu option the bot sent', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [config()] })
    await processSocialEvent(db, event())
    const conversationId = tables.conversations[0].id
    tables.messages.push({
      id: 'bot-menu',
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'interactive',
      interactive_payload: {
        kind: 'list',
        body: 'Elige',
        button_label: 'Ver',
        sections: [{ rows: [{ id: 'cocinas', title: 'Cocinas', description: 'x' }, { id: 'campanas', title: 'Campanas' }] }],
      },
      created_at: '2026-10-24T10:00:30Z',
    })
    dispatchInboundToFlows.mockClear()

    await processSocialEvent(db, event({ mid: 'mid-2', text: '2', timestamp: Date.parse('2026-10-24T10:01:00Z') }))

    expect(dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ kind: 'interactive_reply', reply_id: 'campanas', reply_title: 'Campanas' }),
      }),
    )
    const row = tables.messages.find((m) => m.message_id === 'mid-2')
    expect(row).toMatchObject({ content_type: 'interactive', interactive_reply_id: 'campanas' })
  })

  it('routes a quick-reply tap by its payload', async () => {
    const { db } = fakeDb({ social_channel_configs: [config()] })
    await processSocialEvent(db, event({ text: 'Cotizar', replyPayload: 'cotizar' }))
    expect(dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ kind: 'interactive_reply', reply_id: 'cotizar' }) }),
    )
  })

  it('hands a first message nobody answered over to an advisor', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [config()] })
    // Flow consumed it but sent nothing (e.g. a WhatsApp-only phone gate).
    dispatchInboundToFlows.mockResolvedValue({ consumed: true })
    await processSocialEvent(db, event())
    expect(engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: SOCIAL_FALLBACK_HANDOFF_TEXT }))
    expect(tables.conversations[0]).toMatchObject({ status: 'pending', ai_autoreply_disabled: true })
  })

  it('does not hand off when the bot already answered', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [config()] })
    dispatchInboundToFlows.mockImplementation(async (a: { conversationId: string }) => {
      tables.messages.push({
        id: 'bot-1',
        conversation_id: a.conversationId,
        sender_type: 'bot',
        content_type: 'text',
        created_at: new Date().toISOString(),
      })
      return { consumed: true }
    })
    await processSocialEvent(db, event())
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('stores an ad referral for attribution', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [config({ channel: 'messenger', external_id: 'PAGE-1' })] })
    await processSocialEvent(
      db,
      event({
        channel: 'messenger',
        externalId: 'PAGE-1',
        senderId: 'PSID-1',
        referral: {
          ad_id: 'AD-1',
          ref: null,
          source: 'ADS',
          type: 'OPEN_THREAD',
          headline: 'Cocinas',
          image_url: null,
          video_url: null,
          source_url: null,
          raw: {},
        },
      }),
    )
    expect(tables.conversation_referrals).toHaveLength(1)
    expect(tables.conversation_referrals[0]).toMatchObject({ channel: 'messenger', source_id: 'AD-1', headline: 'Cocinas' })
  })
})
