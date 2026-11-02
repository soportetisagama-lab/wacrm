import { describe, expect, it } from 'vitest'
import {
  canViewChannel,
  channelOf,
  isMetaSocialChannel,
  isSocialChannel,
  isWithinMessagingWindow,
  supportsWhatsAppFeatures,
} from './types'

describe('channelOf', () => {
  it('defaults to whatsapp for missing / unknown values (rows read before migration 080)', () => {
    expect(channelOf(null)).toBe('whatsapp')
    expect(channelOf({})).toBe('whatsapp')
    expect(channelOf({ channel: 'fax' })).toBe('whatsapp')
    expect(channelOf({ channel: 'instagram' })).toBe('instagram')
    expect(channelOf({ channel: 'messenger' })).toBe('messenger')
    expect(channelOf({ channel: 'tiktok' })).toBe('tiktok')
  })

  it('instagram, messenger and tiktok are social channels; only the first two go through Meta', () => {
    expect(isSocialChannel('instagram')).toBe(true)
    expect(isSocialChannel('messenger')).toBe(true)
    expect(isSocialChannel('tiktok')).toBe(true)
    expect(isSocialChannel('whatsapp')).toBe(false)
    expect(isMetaSocialChannel('instagram')).toBe(true)
    expect(isMetaSocialChannel('messenger')).toBe(true)
    expect(isMetaSocialChannel('tiktok')).toBe(false)
    expect(isMetaSocialChannel('whatsapp')).toBe(false)
  })
})

describe('isWithinMessagingWindow', () => {
  const now = new Date('2026-10-24T12:00:00Z')
  it('is open for 24 h after the last customer message', () => {
    expect(isWithinMessagingWindow('2026-10-24T11:00:00Z', now)).toBe(true)
    expect(isWithinMessagingWindow('2026-10-23T12:00:01Z', now)).toBe(true)
  })
  it('is closed after 24 h or with no customer message', () => {
    expect(isWithinMessagingWindow('2026-10-23T12:00:00Z', now)).toBe(false)
    expect(isWithinMessagingWindow(null, now)).toBe(false)
    expect(isWithinMessagingWindow('not a date', now)).toBe(false)
  })
})

describe('canViewChannel (mirror of can_view_social_channel, migration 080)', () => {
  it('never restricts WhatsApp', () => {
    for (const role of ['owner', 'admin', 'gerencia', 'atc', 'agent', 'viewer']) {
      expect(canViewChannel({ channel: 'whatsapp', role, showToAgents: false })).toBe(true)
    }
  })

  it('shows Instagram/Messenger/TikTok only to owner/admin by default', () => {
    for (const channel of ['instagram', 'messenger', 'tiktok'] as const) {
      expect(canViewChannel({ channel, role: 'owner', showToAgents: false })).toBe(true)
      expect(canViewChannel({ channel, role: 'admin', showToAgents: false })).toBe(true)
      for (const role of ['gerencia', 'jefe_linea', 'atc', 'agent', 'viewer', 'analista']) {
        expect(canViewChannel({ channel, role, showToAgents: false })).toBe(false)
      }
    }
  })

  it('always shows Instagram/Messenger/TikTok to community_manager (migrations 084, 087)', () => {
    for (const showToAgents of [false, true]) {
      expect(canViewChannel({ channel: 'instagram', role: 'community_manager', showToAgents })).toBe(true)
      expect(canViewChannel({ channel: 'messenger', role: 'community_manager', showToAgents })).toBe(true)
      expect(canViewChannel({ channel: 'tiktok', role: 'community_manager', showToAgents })).toBe(true)
    }
  })

  it('opens them to the rest of the team when the toggle is on', () => {
    expect(canViewChannel({ channel: 'instagram', role: 'agent', showToAgents: true })).toBe(true)
    expect(canViewChannel({ channel: 'messenger', role: 'atc', showToAgents: true })).toBe(true)
  })
})

describe('supportsWhatsAppFeatures', () => {
  it('needs a WhatsApp contact with a phone', () => {
    expect(supportsWhatsAppFeatures({ phone: '+51999999999' })).toBe(true)
    expect(supportsWhatsAppFeatures({ channel: 'whatsapp', phone: null })).toBe(false)
    expect(supportsWhatsAppFeatures({ channel: 'instagram', phone: '+51999999999' })).toBe(false)
  })
})
