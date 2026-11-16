import { describe, it, expect } from 'vitest'
import { configReapertura, notaReapertura, tocaReapertura, ventanaCerrada } from './derivacion-reapertura'

function lima(isoLocal: string): Date {
  return new Date(`${isoLocal}:00-05:00`)
}
const sinFeriados = () => false

describe('tocaReapertura', () => {
  it('lunes de 07:00 a 07:29', () => {
    expect(tocaReapertura(lima('2026-11-16T06:59'), sinFeriados)).toBeNull()
    expect(tocaReapertura(lima('2026-11-16T07:00'), sinFeriados)).toBe('2026-11-16')
    expect(tocaReapertura(lima('2026-11-16T07:30'), sinFeriados)).toBeNull()
  })
  it('martes normal no; día después de feriado sí', () => {
    expect(tocaReapertura(lima('2026-11-17T07:05'), sinFeriados)).toBeNull()
    expect(tocaReapertura(lima('2026-12-10T07:05'))).toBe('2026-12-10') // 8 y 9 dic feriados
  })
  it('lunes feriado no envía; el martes sí', () => {
    const feriado = (f: string) => f === '2026-11-16'
    expect(tocaReapertura(lima('2026-11-16T07:05'), feriado)).toBeNull()
    expect(tocaReapertura(lima('2026-11-17T07:05'), feriado)).toBe('2026-11-17')
  })
})

describe('ventanaCerrada', () => {
  const now = lima('2026-11-16T07:00')
  it('24 h o más desde el último mensaje del cliente', () => {
    expect(ventanaCerrada(lima('2026-11-15T07:00'), now)).toBe(true)
    expect(ventanaCerrada(lima('2026-11-15T07:01'), now)).toBe(false)
    expect(ventanaCerrada(null, now)).toBe(true)
  })
})

it('apagada por defecto y nota del día', () => {
  expect(configReapertura({})).toEqual({ activa: false, plantilla: 'reapertura_consulta', idioma: 'es_PE' })
  expect(notaReapertura('2026-11-16')).toBe('Plantilla enviada 7:00 (16/11)')
})
