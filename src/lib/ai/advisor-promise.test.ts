import { describe, expect, it } from 'vitest'

import { filterAdvisorPromises, sentencePromisesAdvisor } from './advisor-promise'
import { ASK_PHONE_TEXT } from './awaiting-phone'
import { NO_ADVISOR_PROMISE_GUIDANCE, buildSystemPrompt } from './defaults'

describe('sentencePromisesAdvisor', () => {
  it.each([
    'Un asesor te escribe por aquí en breve.',
    'Un asesor del equipo te contactará pronto 👍',
    'Nuestro asesor te llamará mañana.',
    'Una asesora te va a escribir en unos minutos.',
    'Los asesores se comunicarán contigo.',
    'Un asesor se pondrá en contacto contigo.',
    'Te derivo con un asesor.',
    'Te paso con un asesor del equipo.',
    'Ya derivé tu consulta a un asesor.',
    'Alguien del equipo te escribirá.',
    'Una persona de nuestro equipo te responderá por aquí.',
    'El equipo de ventas te contactará.',
    'Te contactamos pronto.',
    'Te llamaremos mañana.',
    'Nos pondremos en contacto contigo.',
    'Un asesor va a tomar tu caso.',
  ])('flags "%s"', (s) => {
    expect(sentencePromisesAdvisor(s)).toBe(true)
  })

  it.each([
    '¿Quieres hablar con un asesor?',
    '¿Quieres que un asesor te llame?',
    'Si prefieres, puedes hablar con un asesor.',
    'Un asesor puede ayudarte con eso.',
    'Ofrecemos asesoría personalizada para tu proyecto.',
    'Te damos asesoramiento en el diseño.',
    'El asesor que te atendió ya no está disponible.',
    'Nuestro equipo trabaja de lunes a viernes.',
    'Te escribimos la información aquí mismo.',
    'Hacemos cocinas de acero inoxidable a medida.',
  ])('keeps "%s"', (s) => {
    expect(sentencePromisesAdvisor(s)).toBe(false)
  })
})

describe('filterAdvisorPromises', () => {
  it('leaves a clean reply untouched', () => {
    const text = 'Hacemos mesas a medida. ¿En qué ciudad estás?'
    expect(filterAdvisorPromises(text, { hasPhone: false })).toEqual({ text, removed: [] })
  })

  it('removes the promise and keeps the rest when the number is on file', () => {
    const out = filterAdvisorPromises('Perfecto, ya tengo tus datos. Un asesor te escribe en breve 👍', { hasPhone: true })
    expect(out.text).toBe('Perfecto, ya tengo tus datos.')
    expect(out.removed).toHaveLength(1)
  })

  it('without a number the promise becomes the ask for the celular', () => {
    const out = filterAdvisorPromises('Gracias por la info. Te paso con un asesor. ¡Saludos!', { hasPhone: false })
    expect(out.text).toBe(`Gracias por la info. ${ASK_PHONE_TEXT} ¡Saludos!`)
  })

  it('nothing left: the ask, even with a number on file', () => {
    expect(filterAdvisorPromises('Un asesor te contactará pronto.', { hasPhone: true }).text).toBe(ASK_PHONE_TEXT)
  })

  it('never asks twice', () => {
    const out = filterAdvisorPromises(`Un asesor te llamará. ${ASK_PHONE_TEXT}`, { hasPhone: false })
    expect(out.text).toBe(ASK_PHONE_TEXT)
    const two = filterAdvisorPromises('Te derivo con un asesor. Un asesor te escribirá.', { hasPhone: false })
    expect(two.text).toBe(ASK_PHONE_TEXT)
    expect(two.removed).toHaveLength(2)
  })

  it('keeps line breaks of the remaining text', () => {
    const out = filterAdvisorPromises('Tenemos dos modelos:\n- Mesa A\n- Mesa B\nUn asesor te escribe.', { hasPhone: true })
    expect(out.text).toBe('Tenemos dos modelos:\n- Mesa A\n- Mesa B')
  })
})

describe('NO_ADVISOR_PROMISE_GUIDANCE in the auto-reply prompt', () => {
  it('uses the exact ask text', () => {
    expect(NO_ADVISOR_PROMISE_GUIDANCE).toContain(ASK_PHONE_TEXT)
  })

  it('only in auto_reply mode, only when asked, before the price rule', () => {
    const on = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', noAdvisorPromise: true })
    expect(on).toContain(NO_ADVISOR_PROMISE_GUIDANCE)
    expect(on.trimEnd().endsWith(NO_ADVISOR_PROMISE_GUIDANCE)).toBe(false)
    expect(buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })).not.toContain(NO_ADVISOR_PROMISE_GUIDANCE)
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft', noAdvisorPromise: true })).not.toContain(
      NO_ADVISOR_PROMISE_GUIDANCE,
    )
  })
})
