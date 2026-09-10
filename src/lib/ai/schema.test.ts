import { describe, it, expect } from 'vitest'
import {
  buildExtractionSchema,
  buildExtractionPrompt,
  EXTRACTION_TOOL_NAME,
  type DocumentOption,
  type ExtractionField,
} from './schema'

const FIELDS: ExtractionField[] = [
  { key: 'equipos', label: 'Equipos', description: 'Qué equipos inox quiere cotizar', required: true },
  { key: 'ciudad', label: 'Ciudad', required: true },
  { key: 'rubro', label: 'Rubro del negocio', required: false },
]

const DOCUMENTS: DocumentOption[] = [
  { key: 'catalogo', label: 'Catálogo de productos' },
  { key: 'lista_precios', label: 'Lista de precios' },
]

describe('EXTRACTION_TOOL_NAME', () => {
  it('is a stable, non-empty tool name', () => {
    expect(EXTRACTION_TOOL_NAME).toBe('submit')
  })
})

describe('buildExtractionSchema', () => {
  it('lists every field key as nullable + required (key must appear, value may be null)', () => {
    const schema = buildExtractionSchema(FIELDS) as {
      properties: {
        extracted: {
          properties: Record<string, { type: string[] }>
          required: string[]
          additionalProperties: boolean
        }
      }
      required: string[]
      additionalProperties: boolean
    }

    const extracted = schema.properties.extracted
    expect(Object.keys(extracted.properties)).toEqual(['equipos', 'ciudad', 'rubro'])
    expect(extracted.required).toEqual(['equipos', 'ciudad', 'rubro'])
    expect(extracted.additionalProperties).toBe(false)
    for (const key of ['equipos', 'ciudad', 'rubro']) {
      expect(extracted.properties[key].type).toEqual(['string', 'null'])
    }
  })

  it('carries the control fields (reply_text, done, handoff) as top-level required', () => {
    const schema = buildExtractionSchema(FIELDS) as { required: string[] }
    expect(schema.required).toEqual(['extracted', 'reply_text', 'done', 'handoff'])
  })

  it('is additionalProperties:false at every level (required for OpenAI strict mode)', () => {
    const schema = buildExtractionSchema(FIELDS) as {
      additionalProperties: boolean
      properties: { extracted: { additionalProperties: boolean } }
    }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.extracted.additionalProperties).toBe(false)
  })

  it('uses the field description, falling back to the label when absent', () => {
    const schema = buildExtractionSchema(FIELDS) as {
      properties: { extracted: { properties: Record<string, { description: string }> } }
    }
    expect(schema.properties.extracted.properties.equipos.description).toBe(
      'Qué equipos inox quiere cotizar',
    )
    expect(schema.properties.extracted.properties.ciudad.description).toBe('Ciudad')
  })

  it('omits send_document entirely when no documents are configured', () => {
    const schema = buildExtractionSchema(FIELDS) as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.properties.send_document).toBeUndefined()
    expect(schema.required).not.toContain('send_document')
  })

  it('adds send_document, nullable, constrained to the configured keys, when documents are present', () => {
    const schema = buildExtractionSchema(FIELDS, DOCUMENTS) as {
      properties: { send_document: { type: string[]; enum: (string | null)[] } }
      required: string[]
    }
    expect(schema.properties.send_document.type).toEqual(['string', 'null'])
    expect(schema.properties.send_document.enum).toEqual(['catalogo', 'lista_precios', null])
    expect(schema.required).toContain('send_document')
  })
})

describe('buildExtractionPrompt', () => {
  it('lists every field with its required/optional marker', () => {
    const prompt = buildExtractionPrompt({ fields: FIELDS, knownValues: {} })
    expect(prompt).toContain('equipos (required)')
    expect(prompt).toContain('ciudad (required)')
    expect(prompt).toContain('rubro (optional)')
  })

  it('separates already-known values from still-missing ones', () => {
    const prompt = buildExtractionPrompt({
      fields: FIELDS,
      knownValues: { ciudad: 'Trujillo' },
    })
    expect(prompt).toContain('Already collected')
    expect(prompt).toContain('ciudad: Trujillo')
    expect(prompt).toContain('Still missing')
    expect(prompt).toContain('- equipos')
    expect(prompt).toContain('- rubro')
    // A known field must not also be listed as missing.
    const missingSection = prompt.slice(prompt.indexOf('Still missing'))
    expect(missingSection).not.toContain('- ciudad')
  })

  it('omits the "Already collected" section when nothing is known yet', () => {
    const prompt = buildExtractionPrompt({ fields: FIELDS, knownValues: {} })
    expect(prompt).not.toContain('Already collected')
  })

  it('omits the "Still missing" section once everything is known', () => {
    const prompt = buildExtractionPrompt({
      fields: FIELDS,
      knownValues: { equipos: '2 cocinas', ciudad: 'Trujillo', rubro: 'restaurante' },
    })
    expect(prompt).not.toContain('Still missing')
  })

  it('includes the shared anti-injection guard', () => {
    const prompt = buildExtractionPrompt({ fields: FIELDS, knownValues: {} })
    expect(prompt).toContain('untrusted content')
  })

  it('appends business context only when provided', () => {
    const withCtx = buildExtractionPrompt({
      fields: FIELDS,
      knownValues: {},
      systemContext: 'Rubros válidos: restaurante, panadería, hotel.',
    })
    expect(withCtx).toContain('Business context and instructions')
    expect(withCtx).toContain('Rubros válidos')

    const withoutCtx = buildExtractionPrompt({ fields: FIELDS, knownValues: {} })
    expect(withoutCtx).not.toContain('Business context and instructions')
  })

  it('lists available documents by key + label, only when configured', () => {
    const withDocs = buildExtractionPrompt({
      fields: FIELDS,
      knownValues: {},
      documents: DOCUMENTS,
    })
    expect(withDocs).toContain('catalogo: Catálogo de productos')
    expect(withDocs).toContain('lista_precios: Lista de precios')
    expect(withDocs).toContain('send_document')

    const withoutDocs = buildExtractionPrompt({ fields: FIELDS, knownValues: {} })
    expect(withoutDocs).not.toContain('Documents you can send')
  })
})
