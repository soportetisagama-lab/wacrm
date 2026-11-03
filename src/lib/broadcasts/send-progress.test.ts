import { describe, expect, it } from 'vitest'

import { liveSendPercent, liveSendStats, sendEtaMinutes, sendLooksWrong } from './send-progress'

describe('sendEtaMinutes', () => {
  it('estima con el ritmo promedio', () => {
    // 100 en 60 s: faltan 1100 a 0.6 s cada uno = 11 min
    expect(sendEtaMinutes({ total: 1200, sent: 90, failed: 10, startedAt: 1 }, 60_001)).toBe(11)
  })
  it('null antes de empezar o al terminar', () => {
    expect(sendEtaMinutes({ total: 10, sent: 0, failed: 0, startedAt: 1 }, 1000)).toBeNull()
    expect(sendEtaMinutes({ total: 10, sent: 10, failed: 0, startedAt: 1 }, 1000)).toBeNull()
  })
})

describe('sendLooksWrong', () => {
  it('avisa si más de la mitad falla con muestra suficiente', () => {
    expect(sendLooksWrong({ total: 100, sent: 5, failed: 20, startedAt: 1 })).toBe(true)
  })
  it('no avisa con pocos procesados o pocos fallos', () => {
    expect(sendLooksWrong({ total: 100, sent: 0, failed: 5, startedAt: 1 })).toBe(false)
    expect(sendLooksWrong({ total: 100, sent: 40, failed: 2, startedAt: 1 })).toBe(false)
  })
})

describe('liveSendStats', () => {
  it('cuenta procesados como total menos pendientes', () => {
    const s = liveSendStats({ total: 100, pending: 60, failed: 5 }, { at: 1, done: 30 })
    expect(s).toEqual({ total: 100, sent: 35, failed: 5, startedAt: 1, baseline: 30 })
    expect(liveSendPercent(s)).toBe(40)
  })
  it('el ritmo solo cuenta lo hecho desde la primera lectura', () => {
    // 30 ya hechos al abrir; 10 más en 60 s: faltan 60 a 6 s = 6 min
    const s = liveSendStats({ total: 100, pending: 60, failed: 0 }, { at: 1, done: 30 })
    expect(sendEtaMinutes(s, 60_001)).toBe(6)
  })
  it('sin avance desde la primera lectura no estima', () => {
    const s = liveSendStats({ total: 100, pending: 70, failed: 0 }, { at: 1, done: 30 })
    expect(sendEtaMinutes(s, 60_001)).toBeNull()
  })
})
