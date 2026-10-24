import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeDb } from '@/lib/ai/learning/fake-db.testutil'
import { encrypt } from '@/lib/whatsapp/encryption'

const admin = fakeDb()
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => admin.db }))

import { sendSocialOutbound, SocialSendError } from './send'

const fetchMock = vi.fn()

beforeEach(() => {
  admin.tables.social_channel_configs = [
    {
      account_id: 'acct-1',
      channel: 'messenger',
      external_id: 'PAGE-1',
      page_id: 'PAGE-1',
      access_token: encrypt('page-token'),
      enabled: true,
      show_to_agents: false,
    },
  ]
  admin.tables.messages = [
    {
      conversation_id: 'conv-1',
      sender_type: 'customer',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
  ]
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ message_id: 'm_out' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const contact = { channel: 'messenger', channel_user_id: 'PSID-1' }

function sentBody(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string)
}

describe('sendSocialOutbound', () => {
  it('sends text through the Send API with the page token', async () => {
    const { messageId } = await sendSocialOutbound(admin.db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contact,
      outbound: { kind: 'text', text: 'Hola' },
    })
    expect(messageId).toBe('m_out')
    expect(fetchMock.mock.calls[0][0]).toContain('/me/messages')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer page-token')
    expect(sentBody()).toEqual({
      recipient: { id: 'PSID-1' },
      messaging_type: 'RESPONSE',
      message: { text: 'Hola' },
    })
  })

  it('refuses outside the 24 h window without calling Meta', async () => {
    admin.tables.messages[0].created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await expect(
      sendSocialOutbound(admin.db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contact,
        outbound: { kind: 'text', text: 'Hola' },
      }),
    ).rejects.toMatchObject({ code: 'window_closed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails clearly when the channel is not connected', async () => {
    admin.tables.social_channel_configs = []
    const err = await sendSocialOutbound(admin.db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contact,
      outbound: { kind: 'text', text: 'Hola' },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(SocialSendError)
    expect(err.code).toBe('not_configured')
  })

  it('sends a short menu as quick replies', async () => {
    await sendSocialOutbound(admin.db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contact,
      outbound: {
        kind: 'interactive',
        payload: { kind: 'buttons', body: '¿Qué necesitas?', buttons: [{ id: 'cotizar', title: 'Cotizar' }] },
      },
    })
    expect(sentBody().message).toEqual({
      text: '¿Qué necesitas?',
      quick_replies: [{ content_type: 'text', title: 'Cotizar', payload: 'cotizar' }],
    })
  })

  it('sends an image as an attachment, caption as its own text', async () => {
    await sendSocialOutbound(admin.db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contact,
      outbound: { kind: 'media', mediaKind: 'image', url: 'https://x/y.jpg', caption: 'Modelo A' },
    })
    expect(sentBody(0).message).toEqual({
      attachment: { type: 'image', payload: { url: 'https://x/y.jpg', is_reusable: false } },
    })
    expect(sentBody(1).message).toEqual({ text: 'Modelo A' })
  })

  it('maps Meta’s window error to window_closed', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { message: 'This message is sent outside of allowed window.', code: 10, error_subcode: 2018278 } }),
        { status: 400 },
      ),
    )
    await expect(
      sendSocialOutbound(admin.db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contact,
        outbound: { kind: 'text', text: 'Hola' },
      }),
    ).rejects.toMatchObject({ code: 'window_closed' })
  })

  it('refuses documents on Instagram', async () => {
    admin.tables.social_channel_configs[0].channel = 'instagram'
    await expect(
      sendSocialOutbound(admin.db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contact: { channel: 'instagram', channel_user_id: 'IGSID-1' },
        outbound: { kind: 'media', mediaKind: 'document', url: 'https://x/a.pdf' },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })
})
