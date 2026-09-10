import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'
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
