import { describe, it, expect } from 'vitest'
import { domingoDePascua, esFeriado, feriadosDelAnio, feriadosPausanDerivacion } from './feriados-peru'

describe('feriados de Perú', () => {
  it('calcula la Pascua', () => {
    expect(domingoDePascua(2026)).toBe('2026-04-05')
    expect(domingoDePascua(2027)).toBe('2027-03-28')
  })
  it('incluye Jueves y Viernes Santo y los fijos', () => {
    const f = feriadosDelAnio(2026)
    expect(f.get('2026-04-02')).toBe('Jueves Santo')
    expect(f.get('2026-04-03')).toBe('Viernes Santo')
    expect(f.size).toBe(16)
    expect(esFeriado('2026-12-08', {})).toBe(true)
    expect(esFeriado('2026-11-16', {})).toBe(false)
  })
  it('acepta días extra por variable', () => {
    expect(esFeriado('2026-12-24', { FERIADOS_EXTRA: '2026-12-24, 2026-12-31' })).toBe(true)
  })
  it('apagado por defecto', () => {
    expect(feriadosPausanDerivacion({})).toBe(false)
    expect(feriadosPausanDerivacion({ FERIADOS_PAUSAN_DERIVACION: '1' })).toBe(true)
  })
})
