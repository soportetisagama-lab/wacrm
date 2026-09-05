import { describe, expect, it } from 'vitest'
import { resolveRecipient, toRecipientTarget } from './recipient'

describe('resolveRecipient', () => {
  it('prefers phone when both phone and BSUID are present', () => {
    expect(
      resolveRecipient({ phone: '+1 (555) 123-4567', whatsapp_user_id: 'US.abc123' }),
    ).toEqual({ kind: 'phone', value: '15551234567' })
  })

  it('sanitizes the phone number (strips formatting)', () => {
    expect(resolveRecipient({ phone: '+51 926 843 129', whatsapp_user_id: null })).toEqual({
      kind: 'phone',
      value: '51926843129',
    })
  })

  it('falls back to BSUID, unmodified, when there is no phone', () => {
    expect(resolveRecipient({ phone: null, whatsapp_user_id: 'US.13491208655302741918' })).toEqual(
      { kind: 'bsuid', value: 'US.13491208655302741918' },
    )
  })

  it('falls back to BSUID when phone is an empty string', () => {
    expect(resolveRecipient({ phone: '', whatsapp_user_id: 'US.abc123' })).toEqual({
      kind: 'bsuid',
      value: 'US.abc123',
    })
  })

  it('returns null when neither phone nor BSUID is present', () => {
    expect(resolveRecipient({ phone: null, whatsapp_user_id: null })).toBeNull()
  })

  it('returns null when whatsapp_user_id is omitted entirely', () => {
    expect(resolveRecipient({ phone: null })).toBeNull()
  })
})

describe('toRecipientTarget', () => {
  it('produces { to } for a phone identifier, with no recipient key', () => {
    const target = toRecipientTarget({ kind: 'phone', value: '15551234567' })
    expect(target).toEqual({ to: '15551234567' })
    expect('recipient' in target).toBe(false)
  })

  it('produces { recipient } for a bsuid identifier, with no to key', () => {
    const target = toRecipientTarget({ kind: 'bsuid', value: 'US.abc123' })
    expect(target).toEqual({ recipient: 'US.abc123' })
    expect('to' in target).toBe(false)
  })
})
