import { beforeEach, describe, expect, it, vi } from 'vitest'

const replyToComment = vi.fn()
const sendPrivateReply = vi.fn()

vi.mock('./graph', () => {
  class GraphApiError extends Error {
    code: number | null
    subcode: number | null
    constructor(message: string, code: number | null, subcode: number | null) {
      super(message)
      this.code = code
      this.subcode = subcode
    }
  }
  return {
    GraphApiError,
    replyToComment: (a: unknown) => replyToComment(a),
    sendPrivateReply: (a: unknown) => sendPrivateReply(a),
    fetchSocialProfile: async () => ({ name: 'Ana Pérez', username: null, avatarUrl: null }),
  }
})

import { fakeDb } from '@/lib/ai/learning/fake-db.testutil'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  DEFAULT_COMMENT_PRIVATE_REPLY,
  DEFAULT_COMMENT_PUBLIC_REPLY,
  commentReplyTextError,
  processSocialComment,
} from './comments'
import type { SocialCommentEvent } from './parse'

const NOW = Date.parse('2026-10-27T15:00:00Z')

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-fb',
    account_id: 'acct-1',
    user_id: 'admin-1',
    channel: 'messenger',
    external_id: 'PAGE-1',
    page_id: 'PAGE-1',
    access_token: encrypt('page-token'),
    enabled: true,
    show_to_agents: false,
    comment_replies_enabled: true,
    comment_public_reply: null,
    comment_private_reply: null,
    ...overrides,
  }
}

function comment(overrides: Partial<SocialCommentEvent> = {}): SocialCommentEvent {
  return {
    channel: 'messenger',
    externalId: 'PAGE-1',
    commentId: 'c-1',
    postId: 'PAGE-1_POST-1',
    commenterId: 'USER-9',
    timestamp: NOW - 60_000,
    live: false,
    ...overrides,
  }
}

beforeEach(() => {
  replyToComment.mockResolvedValue('reply-1')
  sendPrivateReply.mockResolvedValue({ messageId: 'mid-1', recipientId: 'PSID-9' })
})

describe('processSocialComment', () => {
  it('sends the public reply and the private message with the default texts', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [cfg()] })
    const out = await processSocialComment(db, comment(), NOW)
    expect(out).toEqual({ public: 'sent', private: 'sent' })
    expect(replyToComment).toHaveBeenCalledWith({
      channel: 'messenger',
      commentId: 'c-1',
      message: DEFAULT_COMMENT_PUBLIC_REPLY,
      accessToken: 'page-token',
    })
    expect(sendPrivateReply).toHaveBeenCalledWith({
      pageId: 'PAGE-1',
      commentId: 'c-1',
      text: DEFAULT_COMMENT_PRIVATE_REPLY,
      accessToken: 'page-token',
    })
    const row = tables.social_comment_replies[0]
    expect(row.public_reply_id).toBe('reply-1')
    expect(row.private_message_id).toBe('mid-1')
    expect(row.public_sent_at).toBeTruthy()
    expect(row.private_sent_at).toBeTruthy()
  })

  it('creates the commenter contact by the PSID Meta returned', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [cfg()] })
    await processSocialComment(db, comment(), NOW)
    expect(tables.contacts).toHaveLength(1)
    expect(tables.contacts[0]).toMatchObject({ channel: 'messenger', channel_user_id: 'PSID-9', phone: null })
    expect(tables.messages).toHaveLength(1)
  })

  it('stores the private reply in the commenter conversation and waits for the number', async () => {
    const { db, tables } = fakeDb({
      social_channel_configs: [cfg()],
      contacts: [{ id: 'contact-1', account_id: 'acct-1', channel: 'messenger', channel_user_id: 'PSID-9', phone: null, contact_phone: null }],
    })
    await processSocialComment(db, comment(), NOW)
    expect(tables.contacts).toHaveLength(1)
    expect(tables.conversations).toHaveLength(1)
    const conv = tables.conversations[0]
    expect(conv.contact_id).toBe(tables.contacts[0].id)
    expect(tables.messages).toEqual([
      expect.objectContaining({
        conversation_id: conv.id,
        sender_type: 'bot',
        content_text: DEFAULT_COMMENT_PRIVATE_REPLY,
        message_id: 'mid-1',
      }),
    ])
    expect(conv.last_message_text).toBe(DEFAULT_COMMENT_PRIVATE_REPLY)
    expect(String(conv.ai_handoff_summary)).toMatch(/^📵 .*\(1\/3\)/)
    expect(String(conv.ai_handoff_summary)).toContain('"welcome":true')
  })

  it('an existing thread is reused; an assigned or already held one keeps its state', async () => {
    const { db, tables } = fakeDb({
      social_channel_configs: [cfg()],
      contacts: [{ id: 'contact-1', account_id: 'acct-1', channel: 'messenger', channel_user_id: 'PSID-9', phone: null, contact_phone: null }],
      conversations: [{ id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1', assigned_agent_id: 'agent-1', ai_handoff_summary: null, created_at: '2026-10-01T00:00:00Z' }],
    })
    await processSocialComment(db, comment(), NOW)
    expect(tables.contacts).toHaveLength(1)
    expect(tables.conversations).toHaveLength(1)
    expect(tables.messages).toHaveLength(1)
    expect(tables.conversations[0].ai_handoff_summary).toBeNull()
  })

  it('a contact that already gave the number gets no hold', async () => {
    const { db, tables } = fakeDb({
      social_channel_configs: [cfg()],
      contacts: [{ id: 'contact-1', account_id: 'acct-1', channel: 'messenger', channel_user_id: 'PSID-9', phone: null, contact_phone: '51974710551' }],
    })
    await processSocialComment(db, comment(), NOW)
    expect(tables.messages).toHaveLength(1)
    expect(tables.conversations[0].ai_handoff_summary ?? null).toBeNull()
  })

  it('does nothing while the switch is off (default)', async () => {
    const { db, tables } = fakeDb({ social_channel_configs: [cfg({ comment_replies_enabled: false })] })
    expect(await processSocialComment(db, comment(), NOW)).toBe('disabled')
    expect(replyToComment).not.toHaveBeenCalled()
    expect(sendPrivateReply).not.toHaveBeenCalled()
    expect(tables.social_comment_replies ?? []).toHaveLength(0)
  })

  it('ignores comments of unknown pages', async () => {
    const { db } = fakeDb({ social_channel_configs: [cfg()] })
    expect(await processSocialComment(db, comment({ externalId: 'OTHER' }), NOW)).toBe('disabled')
  })

  it('a redelivered comment_id is answered only once', async () => {
    const { db } = fakeDb({ social_channel_configs: [cfg()] })
    await processSocialComment(db, comment(), NOW)
    expect(await processSocialComment(db, comment(), NOW)).toBe('duplicate')
    expect(replyToComment).toHaveBeenCalledTimes(1)
    expect(sendPrivateReply).toHaveBeenCalledTimes(1)
  })

  it('same person, same post: one private message ever, one public reply per 24 h', async () => {
    const { db } = fakeDb({ social_channel_configs: [cfg()] })
    await processSocialComment(db, comment({ commentId: 'c-1' }), NOW)
    // 4 more comments in a row: nothing else goes out.
    for (let i = 2; i <= 5; i++) {
      expect(await processSocialComment(db, comment({ commentId: `c-${i}` }), NOW + i * 1000)).toEqual({
        public: 'skipped',
        private: 'skipped',
      })
    }
    // 25 h later: public again, still no second private message.
    const later = NOW + 25 * 60 * 60 * 1000
    expect(
      await processSocialComment(db, comment({ commentId: 'c-6', timestamp: later - 1000 }), later),
    ).toEqual({ public: 'sent', private: 'skipped' })
    expect(replyToComment).toHaveBeenCalledTimes(2)
    expect(sendPrivateReply).toHaveBeenCalledTimes(1)
  })

  it('another post or another person is answered normally', async () => {
    const { db } = fakeDb({ social_channel_configs: [cfg()] })
    await processSocialComment(db, comment({ commentId: 'c-1' }), NOW)
    expect(await processSocialComment(db, comment({ commentId: 'c-2', postId: 'PAGE-1_POST-2' }), NOW)).toEqual({
      public: 'sent',
      private: 'sent',
    })
    expect(await processSocialComment(db, comment({ commentId: 'c-3', commenterId: 'USER-8' }), NOW)).toEqual({
      public: 'sent',
      private: 'sent',
    })
  })

  it('if the public reply fails the private message still goes (and vice versa)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db, tables } = fakeDb({ social_channel_configs: [cfg()] })
    replyToComment.mockRejectedValueOnce(new Error('(#200) Permissions error'))
    expect(await processSocialComment(db, comment({ commentId: 'c-1' }), NOW)).toEqual({
      public: 'failed',
      private: 'sent',
    })
    const row = tables.social_comment_replies[0]
    expect(row.public_sent_at).toBeNull()
    expect(String(row.public_error)).toContain('Permissions')

    sendPrivateReply.mockRejectedValueOnce(new Error('boom'))
    expect(await processSocialComment(db, comment({ commentId: 'c-2', commenterId: 'USER-7' }), NOW)).toEqual({
      public: 'sent',
      private: 'failed',
    })
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[social-webhook]'))
    err.mockRestore()
  })

  it('a failed public reply can be retried on the next comment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = fakeDb({ social_channel_configs: [cfg()] })
    replyToComment.mockRejectedValueOnce(new Error('timeout'))
    await processSocialComment(db, comment({ commentId: 'c-1' }), NOW)
    expect(await processSocialComment(db, comment({ commentId: 'c-2' }), NOW + 1000)).toEqual({
      public: 'sent',
      private: 'skipped',
    })
  })

  it('no private message for comments older than 7 days', async () => {
    const { db } = fakeDb({ social_channel_configs: [cfg()] })
    const old = NOW - 8 * 24 * 60 * 60 * 1000
    expect(await processSocialComment(db, comment({ timestamp: old }), NOW)).toEqual({
      public: 'sent',
      private: 'skipped',
    })
  })

  it('Instagram Live comments only get the private message', async () => {
    const { db } = fakeDb({
      social_channel_configs: [cfg({ channel: 'instagram', external_id: 'IG-1' })],
    })
    expect(
      await processSocialComment(db, comment({ channel: 'instagram', externalId: 'IG-1', live: true }), NOW),
    ).toEqual({ public: 'skipped', private: 'sent' })
  })

  it('uses the custom texts and never sends one with a price', async () => {
    const { db } = fakeDb({
      social_channel_configs: [
        cfg({ comment_public_reply: 'Te escribimos 😊', comment_private_reply: 'Ofertas desde S/ 99' }),
      ],
    })
    expect(await processSocialComment(db, comment(), NOW)).toEqual({ public: 'sent', private: 'skipped' })
    expect(replyToComment).toHaveBeenCalledWith(expect.objectContaining({ message: 'Te escribimos 😊' }))
    expect(sendPrivateReply).not.toHaveBeenCalled()
  })
})

describe('commentReplyTextError', () => {
  it('accepts the defaults and rejects prices or overlong texts', () => {
    expect(commentReplyTextError(DEFAULT_COMMENT_PUBLIC_REPLY)).toBeNull()
    expect(commentReplyTextError(DEFAULT_COMMENT_PRIVATE_REPLY)).toBeNull()
    expect(commentReplyTextError('El precio es S/ 120')).not.toBeNull()
    expect(commentReplyTextError('x'.repeat(901))).not.toBeNull()
  })

  it('the defaults ask for the celular and never promise an advisor', () => {
    expect(DEFAULT_COMMENT_PRIVATE_REPLY).toContain('¿nos compartes tu número de celular?')
    expect(DEFAULT_COMMENT_PUBLIC_REPLY).toBe('¡Hola! Te escribimos por mensaje privado 👋')
    expect(commentReplyTextError('Un asesor te escribirá pronto')).toMatch(/asesor/)
    expect(commentReplyTextError('Nuestros asesores te contactan')).not.toBeNull()
    // "asesoría" / "asesoramiento" are not a promise of an advisor.
    expect(commentReplyTextError('Te damos asesoría para tu proyecto')).toBeNull()
    expect(commentReplyTextError('Ofrecemos asesoramiento')).toBeNull()
  })
})
