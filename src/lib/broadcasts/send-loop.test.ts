import { describe, expect, it } from 'vitest'

import {
  filterStillPending,
  isMediaHeaderType,
  loopCounters,
  resumeFinalStatus,
  sendPhaseProgress,
} from './send-loop'

describe('isMediaHeaderType', () => {
  it('reconoce cabeceras de media', () => {
    expect(isMediaHeaderType('image')).toBe(true)
    expect(isMediaHeaderType('video')).toBe(true)
    expect(isMediaHeaderType('document')).toBe(true)
  })
  it('texto o sin cabecera no es media', () => {
    expect(isMediaHeaderType('text')).toBe(false)
    expect(isMediaHeaderType(undefined)).toBe(false)
    expect(isMediaHeaderType(null)).toBe(false)
  })
})

describe('filterStillPending', () => {
  it('salta los que ya no están pendientes y los que no aparecen', () => {
    const batch = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    const status = new Map([
      ['a', 'pending'],
      ['b', 'sent'],
      ['c', 'failed'],
    ])
    expect(filterStillPending(batch, status).map((r) => r.id)).toEqual(['a'])
  })
})

describe('sendPhaseProgress', () => {
  it('mismo cálculo que el envío original (30 + 60 %)', () => {
    expect(sendPhaseProgress(30, 60, 10, 100)).toBe(36)
    expect(sendPhaseProgress(30, 60, 100, 100)).toBe(90)
  })
  it('no se pasa del tope ni divide entre cero', () => {
    expect(sendPhaseProgress(30, 60, 120, 100)).toBe(90)
    expect(sendPhaseProgress(10, 85, 0, 0)).toBe(95)
  })
})

describe('loopCounters', () => {
  it('sin saltados equivale al conteo original', () => {
    expect(loopCounters(100, 20, 3, 0)).toEqual({ total: 100, sent: 17, failed: 3 })
  })
  it('los saltados salen del total y no cuentan como enviados', () => {
    expect(loopCounters(100, 20, 3, 5)).toEqual({ total: 95, sent: 12, failed: 3 })
  })
})

describe('resumeFinalStatus', () => {
  it('failed solo si nadie recibió el mensaje', () => {
    expect(resumeFinalStatus(0)).toBe('failed')
    expect(resumeFinalStatus(480)).toBe('sent')
  })
})
