import { describe, expect, it } from 'vitest'

import { classifyTypedPhone } from '@/lib/whatsapp/phone-utils'
import { ASK_PHONE_TEXT } from './awaiting-phone'
import {
  MAX_HELD_TURNS,
  PHONE_AUDIO_TEXT,
  PHONE_FOREIGN_TEXT,
  PHONE_INCOMPLETE_TEXT,
  PHONE_LANDLINE_TEXT,
  PHONE_MEDIA_TEXT,
  PHONE_MULTIPLE_TEXT,
  PHONE_SAME_NUMBER_TEXT,
  classifyHeldReply,
  decideHeldAction,
  withPhoneAsk,
  type HeldBurstItem,
} from './phone-ask'

const t = (text: string): HeldBurstItem => ({ type: 'text', text })
const kind = (...texts: string[]) => classifyHeldReply(texts.map(t)).kind
const ctx = { turns: 0, lastBusinessText: ASK_PHONE_TEXT }

describe('1. formats of the same number', () => {
  it.each([
    '926843129',
    '926 843 129',
    '926-843-129',
    '+51 926 843 129',
    '51926843129',
    'mi número es 926843129',
  ])('"%s" → 51926843129', (text) => {
    expect(classifyTypedPhone(text)).toEqual({ kind: 'phone', phone: '51926843129' })
    expect(classifyHeldReply([t(text)])).toEqual({ kind: 'phone', phone: '51926843129' })
  })
})

describe('2. incomplete', () => {
  it('asks for the 9 digits, without a button, and does not count', () => {
    expect(kind('92684312')).toBe('incomplete')
    expect(decideHeldAction({ kind: 'incomplete' }, ctx)).toEqual({ action: 'ask_free', text: PHONE_INCOMPLETE_TEXT })
    expect(PHONE_INCOMPLETE_TEXT).toBe('Parece que el número está incompleto 🙏 ¿Nos lo envías de nuevo con los 9 dígitos?')
  })

  it('the same incomplete number twice in a row counts', () => {
    expect(decideHeldAction({ kind: 'incomplete' }, { turns: 1, lastBusinessText: PHONE_INCOMPLETE_TEXT })).toEqual({
      action: 'ask_counted',
      text: PHONE_INCOMPLETE_TEXT,
    })
  })
})

describe('3. foreign numbers', () => {
  it('accepted with "+"', () => {
    expect(classifyTypedPhone('+54 9 11 1234 5678')).toEqual({ kind: 'phone', phone: '5491112345678' })
    expect(classifyTypedPhone('+1 305 555 0123')).toEqual({ kind: 'phone', phone: '13055550123' })
  })

  it('without "+" and not Peruvian: asks for the country code and "+"', () => {
    expect(kind('5491112345678')).toBe('foreign_no_plus')
    expect(decideHeldAction({ kind: 'foreign_no_plus' }, ctx)).toEqual({ action: 'ask_free', text: PHONE_FOREIGN_TEXT })
  })

  it('a RUC or an order number is not a foreign phone', () => {
    expect(classifyTypedPhone('20123456789').kind).toBe('none')
    expect(classifyTypedPhone('mi pedido 1234567890').kind).toBe('none')
  })
})

describe('4. Peruvian landline', () => {
  it.each(['01 4567890', '(01) 456-7890', '+51 1 4567890', '044 123456'])('"%s" asks for a mobile', (text) => {
    expect(classifyTypedPhone(text).kind).toBe('landline')
  })
  it('does not count', () => {
    expect(decideHeldAction({ kind: 'landline' }, ctx)).toEqual({ action: 'ask_free', text: PHONE_LANDLINE_TEXT })
  })
})

describe('5. several numbers', () => {
  it('asks which one', () => {
    expect(kind('926843129 o 987654321')).toBe('multiple')
    expect(decideHeldAction({ kind: 'multiple' }, ctx)).toEqual({ action: 'ask_free', text: PHONE_MULTIPLE_TEXT })
  })
})

describe('6. "this same one" without a number', () => {
  it.each(['este mismo', 'el de WhatsApp', 'ya te lo di', 'a este número', 'el mismo que sale'])('"%s"', (text) => {
    expect(kind(text)).toBe('same_number')
  })
  it('re-asks (no number to take on social) and counts', () => {
    expect(decideHeldAction({ kind: 'same_number' }, ctx)).toEqual({ action: 'ask_counted', text: PHONE_SAME_NUMBER_TEXT })
  })
})

describe('7. a question instead of the number', () => {
  it.each(['¿cuánto cuesta?', '¿hacen envíos a Arequipa?', 'dónde están ubicados', 'tienen en acero 304'])(
    '"%s" → AI answers, then the ask',
    (text) => {
      expect(kind(text)).toBe('question')
      expect(decideHeldAction({ kind: 'question' }, ctx)).toEqual({ action: 'answer_then_ask' })
    },
  )

  it('the ask is added in one line and never twice', () => {
    expect(withPhoneAsk('Estamos en Lima.')).toBe(`Estamos en Lima.\n\n${ASK_PHONE_TEXT}`)
    expect(withPhoneAsk(`Estamos en Lima. ${ASK_PHONE_TEXT}`)).toBe(`Estamos en Lima. ${ASK_PHONE_TEXT}`)
    expect(withPhoneAsk('')).toBe(ASK_PHONE_TEXT)
  })

  it('questions do not count, but the hard cap ends it', () => {
    expect(decideHeldAction({ kind: 'question' }, { turns: MAX_HELD_TURNS - 1, lastBusinessText: null })).toEqual({
      action: 'answer_then_ask',
    })
    expect(decideHeldAction({ kind: 'question' }, { turns: MAX_HELD_TURNS, lastBusinessText: null }).action).toBe(
      'handoff_no_phone',
    )
  })
})

describe('8. spam / noise', () => {
  it('stickers or emojis only, right after an ask: nothing is sent', () => {
    expect(classifyHeldReply([{ type: 'sticker', text: null }]).kind).toBe('ack')
    expect(kind('😂😂😂')).toBe('ack')
    expect(decideHeldAction({ kind: 'ack' }, ctx)).toEqual({ action: 'ask_free', text: null })
  })

  it('images and files: asks to write it; audio without transcript: asks to write it', () => {
    expect(classifyHeldReply([{ type: 'image', text: null }]).kind).toBe('media')
    expect(decideHeldAction({ kind: 'media' }, ctx)).toEqual({ action: 'ask_free', text: PHONE_MEDIA_TEXT })
    expect(classifyHeldReply([{ type: 'audio', text: null }]).kind).toBe('audio')
    expect(decideHeldAction({ kind: 'audio' }, ctx)).toEqual({ action: 'ask_free', text: PHONE_AUDIO_TEXT })
  })

  it('an audio with transcript is read as text', () => {
    expect(classifyHeldReply([{ type: 'audio', text: 'mi número es 926 843 129' }])).toEqual({
      kind: 'phone',
      phone: '51926843129',
    })
  })

  it('a burst of 10 messages is one decision (the number on its own line wins)', () => {
    const burst = ['hola', 'hola', '???', 'oye', '926843129', 'gracias', '👍', 'ok', 'ya', 'listo'].map(t)
    expect(classifyHeldReply(burst)).toEqual({ kind: 'phone', phone: '51926843129' })
  })

  it('a link alone is a plain counted re-ask', () => {
    expect(kind('https://www.instagram.com/p/abc123')).toBe('other')
    expect(decideHeldAction({ kind: 'other' }, ctx)).toEqual({ action: 'ask_counted', text: ASK_PHONE_TEXT })
  })

  it('insults: hand off without the number, no loop', () => {
    expect(kind('son unos estafadores')).toBe('insult')
    const a = decideHeldAction({ kind: 'insult' }, ctx)
    expect(a).toMatchObject({ action: 'handoff_no_phone', complaint: true })
  })

  it('an unreadable burst is a plain counted re-ask (never silence)', () => {
    expect(classifyHeldReply([]).kind).toBe('other')
  })
})

describe('10. does not want to give the number', () => {
  it.each(['no quiero dar mi número', 'prefiero que me escriban por aquí', 'por aquí nomás', 'no tengo celular'])(
    '"%s" hands off without the number',
    (text) => {
      expect(kind(text)).toBe('refusal')
      const a = decideHeldAction({ kind: 'refusal' }, ctx)
      expect(a.action).toBe('handoff_no_phone')
      if (a.action === 'handoff_no_phone') expect(a.text).not.toMatch(/asesor|te contact|te escrib|te llam/)
    },
  )
})

describe('11. acknowledgements', () => {
  it.each(['gracias', 'ok', '👍', 'ok gracias', 'listo!', 'Sí, claro'])('"%s" sends no new ask', (text) => {
    expect(kind(text)).toBe('ack')
    expect(decideHeldAction({ kind: 'ack' }, ctx)).toEqual({ action: 'ask_free', text: null })
  })
  it('if the bot had not asked yet, it asks once', () => {
    expect(decideHeldAction({ kind: 'ack' }, { turns: 0, lastBusinessText: 'Hola' })).toEqual({
      action: 'ask_free',
      text: ASK_PHONE_TEXT,
    })
  })
})
