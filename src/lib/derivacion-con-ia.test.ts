import { describe, it, expect } from 'vitest'
import { derivacionConIaActiva } from './derivacion-con-ia'

describe('derivacionConIaActiva (DERIVACION_CON_IA)', () => {
  it('encendido solo con "true" o "1"', () => {
    expect(derivacionConIaActiva('true')).toBe(true)
    expect(derivacionConIaActiva('1')).toBe(true)
    expect(derivacionConIaActiva(' true ')).toBe(true)
  })

  it('apagado si falta o vale otra cosa', () => {
    expect(derivacionConIaActiva(undefined)).toBe(false)
    expect(derivacionConIaActiva('')).toBe(false)
    expect(derivacionConIaActiva('false')).toBe(false)
    expect(derivacionConIaActiva('0')).toBe(false)
    expect(derivacionConIaActiva('si')).toBe(false)
  })
})
