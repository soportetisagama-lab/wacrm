import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL, NO_PRICES_GUIDANCE } from './defaults'
import { buildExtractionPrompt } from './schema'
import { buildNudgePrompt } from './nudge'
import type { AiDocument } from './types'

const DOCUMENTS: AiDocument[] = [
  {
    key: 'catalogo',
    label: 'Catálogo de productos',
    media_type: 'document',
    media_url: 'https://storage.example/catalogo.pdf',
  },
]

describe('buildSystemPrompt', () => {
  it('teaches the handoff sentinel only in auto_reply mode', () => {
    const autoReply = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(autoReply).toContain(HANDOFF_SENTINEL)

    const draft = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(draft).not.toContain(HANDOFF_SENTINEL)
  })

  it('includes the business context only when provided', () => {
    const withCtx = buildSystemPrompt({ userPrompt: 'Somos una ferretería.', mode: 'draft' })
    expect(withCtx).toContain('Somos una ferretería.')

    const withoutCtx = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(withoutCtx).not.toContain('Business context and instructions')
  })

  it('includes knowledge base excerpts only when provided', () => {
    const withKnowledge = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      knowledge: ['Returns accepted within 30 days.'],
    })
    expect(withKnowledge).toContain('Returns accepted within 30 days.')

    const withoutKnowledge = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(withoutKnowledge).not.toContain('Knowledge base')
  })

  it('lists the document catalog + the send-document marker only in auto_reply mode', () => {
    const autoReply = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      documents: DOCUMENTS,
    })
    expect(autoReply).toContain('catalogo: Catálogo de productos')
    expect(autoReply).toContain('[[SEND_DOCUMENT:<key>]]')

    // Draft is reviewed by a human before sending — never taught this,
    // even if documents were passed.
    const draft = buildSystemPrompt({ userPrompt: null, mode: 'draft', documents: DOCUMENTS })
    expect(draft).not.toContain('SEND_DOCUMENT')
    expect(draft).not.toContain('Catálogo de productos')
  })

  it('omits the document section entirely when there is no catalog configured', () => {
    const noDocs = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(noDocs).not.toContain('SEND_DOCUMENT')

    const emptyDocs = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', documents: [] })
    expect(emptyDocs).not.toContain('SEND_DOCUMENT')
  })
})

describe('no prices — business rule: the bot never quotes a price', () => {
  const priceyContext = 'Mesa de acero inox: S/ 1,200. Descuento 10% por volumen.'

  it('the auto-reply prompt forbids prices last, after the business context and the knowledge base', () => {
    const prompt = buildSystemPrompt({
      userPrompt: priceyContext,
      mode: 'auto_reply',
      knowledge: ['Lista de precios: lavadero S/ 800'],
    })
    expect(prompt).toContain(NO_PRICES_GUIDANCE)
    expect(prompt.endsWith(NO_PRICES_GUIDANCE)).toBe(true)
    expect(prompt.indexOf(NO_PRICES_GUIDANCE)).toBeGreaterThan(prompt.indexOf('S/ 800'))
    // Prices are no longer something to look up in the knowledge base.
    expect(prompt).not.toContain('(prices,')
    expect(prompt).not.toContain('(a price,')
  })

  it('the rule says: no prices, amounts or discounts even from the knowledge base; an advisor prepares the quote; keep gathering data', () => {
    expect(NO_PRICES_GUIDANCE).toMatch(/never give prices, amounts/)
    expect(NO_PRICES_GUIDANCE).toMatch(/discounts/)
    expect(NO_PRICES_GUIDANCE).toMatch(/knowledge base/)
    expect(NO_PRICES_GUIDANCE).toMatch(/advisor will prepare their quotation/)
    expect(NO_PRICES_GUIDANCE).toMatch(/keep gathering the details of their project/)
  })

  it('collect_ai (extraction) and the nudge prompts carry it too, after the business context', () => {
    const extraction = buildExtractionPrompt({
      fields: [{ key: 'equipos', label: 'Equipos', required: true }],
      knownValues: {},
      systemContext: priceyContext,
    })
    expect(extraction.endsWith(NO_PRICES_GUIDANCE)).toBe(true)

    const nudge = buildNudgePrompt(priceyContext)
    expect(nudge.endsWith(NO_PRICES_GUIDANCE)).toBe(true)
  })
})
