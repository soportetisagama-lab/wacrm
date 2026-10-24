import { describe, expect, it } from 'vitest'
import { isCatalogOption, mentionsCatalog, withoutCatalogDocuments } from './catalog-request'

describe('catalog-request (línea Maxi)', () => {
  it('detecta pedidos de catálogo con o sin tilde', () => {
    for (const t of ['catálogo', 'Catalogo', 'me pasas el catálogo?', '¿Tienen catálogos?', 'CATÁLOGO DIGITAL']) {
      expect(mentionsCatalog(t)).toBe(true)
    }
    expect(mentionsCatalog('quiero cotizar una cocina')).toBe(false)
    expect(mentionsCatalog('')).toBe(false)
  })

  it('reconoce la opción de menú por id o por título', () => {
    expect(isCatalogOption('catalog', 'Ver productos')).toBe(true)
    expect(isCatalogOption('opt_3', '🖼️ Catálogo digital')).toBe(true)
    expect(isCatalogOption('quote', 'Cotizar')).toBe(false)
  })

  it('quita los documentos de catálogo y deja los demás', () => {
    const docs = [
      { key: 'catalogo', label: 'Catálogo', media_url: 'https://x/catalogo.pdf' },
      { key: 'ficha', label: 'Ficha técnica', media_url: 'https://x/catalogo-2026.pdf' },
      { key: 'precios', label: 'Lista de precios', media_url: 'https://x/precios.pdf' },
    ]
    expect(withoutCatalogDocuments(docs).map((d) => d.key)).toEqual(['precios'])
    expect(withoutCatalogDocuments(undefined)).toEqual([])
  })
})
