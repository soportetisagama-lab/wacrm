import { describe, expect, it, vi } from 'vitest'

vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { fakeDb } from '@/lib/ai/learning/fake-db.testutil'
import { evaluateConditionNode } from './engine'
import type { ConditionNodeConfig, FlowRunRow } from './types'

// The welcome's phone gate is a `contact_field: phone` condition
// ("check_phone_presente", then the Peru / foreign branch). Instagram /
// Messenger keep `phone` NULL (081) and the typed number in
// `contact_phone` (086): the gate must read it, so both channels follow
// the same branches.

const run = { id: 'run-1', contact_id: 'c-1', vars: {} } as unknown as FlowRunRow
const present: ConditionNodeConfig = {
  subject: 'contact_field',
  subject_key: 'phone',
  operator: 'present',
  true_next: 'yes',
  false_next: 'no',
}
const peru: ConditionNodeConfig = { ...present, operator: 'starts_with', value: '51' }

function db(contact: Record<string, unknown>) {
  return fakeDb({ contacts: [{ id: 'c-1', ...contact }] }).db as never
}

describe('phone gate (contact_field: phone)', () => {
  it('WhatsApp reads contacts.phone', async () => {
    expect(await evaluateConditionNode(db({ channel: 'whatsapp', phone: '51926843129' }), run, present)).toBe(true)
    expect(await evaluateConditionNode(db({ channel: 'whatsapp', phone: null }), run, present)).toBe(false)
  })

  it('Instagram / Messenger read contact_phone', async () => {
    expect(
      await evaluateConditionNode(db({ channel: 'instagram', phone: null, contact_phone: '51926843129' }), run, present),
    ).toBe(true)
    expect(
      await evaluateConditionNode(db({ channel: 'messenger', phone: null, contact_phone: null }), run, present),
    ).toBe(false)
  })

  it('the Peru / foreign branch works the same on social', async () => {
    expect(
      await evaluateConditionNode(db({ channel: 'instagram', phone: null, contact_phone: '51926843129' }), run, peru),
    ).toBe(true)
    expect(
      await evaluateConditionNode(db({ channel: 'instagram', phone: null, contact_phone: '5491112345678' }), run, peru),
    ).toBe(false)
  })
})
