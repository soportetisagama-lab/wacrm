import { describe, it, expect } from 'vitest'
import { baseMimeType, extensionFor, parseInboundMediaRef } from './inbound-media'

describe('inbound media helpers', () => {
  it('strips mime parameters', () => {
    expect(baseMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg')
  })

  it("prefers a document's own extension, then the mime type's, then 'bin'", () => {
    expect(extensionFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Cotización.XLSX')).toBe('xlsx')
    expect(extensionFor('audio/ogg; codecs=opus')).toBe('ogg')
    expect(extensionFor('application/zip', 'sin-extension')).toBe('bin')
  })

  it('recognises only our private-bucket refs', () => {
    expect(parseInboundMediaRef('storage://inbound-media/acc/msg.ogg')).toBe('acc/msg.ogg')
    expect(parseInboundMediaRef('https://x.supabase.co/storage/v1/object/public/flow-media/a.jpg')).toBeNull()
    expect(parseInboundMediaRef(null)).toBeNull()
  })
})
