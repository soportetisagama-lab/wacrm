import { describe, expect, it } from 'vitest'
import {
  attachmentPreview,
  channelForObject,
  contentTypeForAttachment,
  parseSocialWebhook,
} from './parse'

const PAGE_ID = '1111'
const IG_ID = '17841400000000000'

describe('channelForObject', () => {
  it('maps Meta objects to channels', () => {
    expect(channelForObject('page')).toBe('messenger')
    expect(channelForObject('instagram')).toBe('instagram')
    expect(channelForObject('whatsapp_business_account')).toBeNull()
    expect(channelForObject(undefined)).toBeNull()
  })
})

describe('parseSocialWebhook', () => {
  it('parses a Messenger text message', () => {
    const events = parseSocialWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          time: 1,
          messaging: [
            {
              sender: { id: 'PSID-1' },
              recipient: { id: PAGE_ID },
              timestamp: 1700000000000,
              message: { mid: 'm_1', text: 'Hola' },
            },
          ],
        },
      ],
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      channel: 'messenger',
      externalId: PAGE_ID,
      senderId: 'PSID-1',
      mid: 'm_1',
      kind: 'message',
      text: 'Hola',
      attachments: [],
      replyPayload: null,
      timestamp: 1700000000000,
    })
  })

  it('parses an Instagram image attachment', () => {
    const [ev] = parseSocialWebhook({
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          messaging: [
            {
              sender: { id: 'IGSID-1' },
              recipient: { id: IG_ID },
              timestamp: 1700000000000,
              message: {
                mid: 'ig_m_1',
                attachments: [{ type: 'image', payload: { url: 'https://cdn.example/a.jpg' } }],
              },
            },
          ],
        },
      ],
    })
    expect(ev.channel).toBe('instagram')
    expect(ev.text).toBeNull()
    expect(ev.attachments).toEqual([{ type: 'image', url: 'https://cdn.example/a.jpg' }])
  })

  it('skips echoes, deletions and the page writing to itself', () => {
    const events = parseSocialWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            { sender: { id: PAGE_ID }, message: { mid: 'm_echo', text: 'x', is_echo: true } },
            { sender: { id: 'PSID-1' }, message: { mid: 'm_echo2', text: 'x', is_echo: true } },
            { sender: { id: 'PSID-1' }, message: { mid: 'm_del', is_deleted: true } },
            { sender: { id: 'PSID-1' }, read: { watermark: 1 } },
            { sender: { id: 'PSID-1' }, delivery: { mids: ['m_1'] } },
          ],
        },
      ],
    })
    expect(events).toEqual([])
  })

  it('carries the quick-reply payload (option id) and ad referral', () => {
    const [ev] = parseSocialWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: 'PSID-1' },
              timestamp: 5,
              message: {
                mid: 'm_qr',
                text: 'Catálogo',
                quick_reply: { payload: 'opt_catalogo' },
                referral: {
                  ad_id: 'AD-9',
                  source: 'ADS',
                  type: 'OPEN_THREAD',
                  ads_context_data: { ad_title: 'Cocinas inox', photo_url: 'https://cdn/x.jpg' },
                },
              },
            },
          ],
        },
      ],
    })
    expect(ev.replyPayload).toBe('opt_catalogo')
    expect(ev.referral).toMatchObject({
      ad_id: 'AD-9',
      headline: 'Cocinas inox',
      image_url: 'https://cdn/x.jpg',
      source: 'ADS',
    })
  })

  it('turns a postback into a reply with a stable synthetic mid', () => {
    const [ev] = parseSocialWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            { sender: { id: 'PSID-1' }, timestamp: 42, postback: { title: 'Empezar', payload: 'GET_STARTED' } },
          ],
        },
      ],
    })
    expect(ev).toMatchObject({
      kind: 'postback',
      text: 'Empezar',
      replyPayload: 'GET_STARTED',
      mid: 'postback:PSID-1:42',
    })
  })

  it('records a bare referral (thread opened from an ad, nothing written yet)', () => {
    const [ev] = parseSocialWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [{ sender: { id: 'PSID-1' }, timestamp: 7, referral: { ref: 'promo', ad_id: 'AD-1' } }],
        },
      ],
    })
    expect(ev.kind).toBe('referral')
    expect(ev.referral?.ref).toBe('promo')
  })

  it('ignores unknown objects and malformed bodies', () => {
    expect(parseSocialWebhook({ object: 'whatsapp_business_account', entry: [] })).toEqual([])
    expect(parseSocialWebhook(null)).toEqual([])
    expect(parseSocialWebhook({ object: 'page', entry: [{ id: PAGE_ID, messaging: [{}] }] })).toEqual([])
  })

  it('labels Messenger stickers as stickers', () => {
    const [ev] = parseSocialWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: 'PSID-1' },
              message: { mid: 'm_st', attachments: [{ type: 'image', payload: { url: 'u', sticker_id: 369239263222822 } }] },
            },
          ],
        },
      ],
    })
    expect(ev.attachments[0].type).toBe('sticker')
  })
})

describe('attachment helpers', () => {
  it('maps attachment types to allowed content types', () => {
    expect(contentTypeForAttachment('image')).toBe('image')
    expect(contentTypeForAttachment('sticker')).toBe('image')
    expect(contentTypeForAttachment('video')).toBe('video')
    expect(contentTypeForAttachment('audio')).toBe('audio')
    expect(contentTypeForAttachment('file')).toBe('document')
    expect(contentTypeForAttachment('share')).toBe('text')
  })

  it('has Spanish previews', () => {
    expect(attachmentPreview('image')).toBe('📷 Foto')
    expect(attachmentPreview('story_mention')).toContain('historia')
  })
})
