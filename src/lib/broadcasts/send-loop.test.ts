import { describe, expect, it } from 'vitest'

import {
  filterStillPending,
  headerMediaProblem,
  pickResumeHeaderMediaUrl,
  storedHeaderMediaUrl,
  isMediaHeaderType,
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

describe('resumeFinalStatus', () => {
  it('failed solo si nadie recibió el mensaje', () => {
    expect(resumeFinalStatus(0)).toBe('failed')
    expect(resumeFinalStatus(480)).toBe('sent')
  })
})

describe('headerMediaProblem', () => {
  it('sin cabecera de media no exige nada', () => {
    expect(headerMediaProblem(false, '')).toBeNull()
  })
  it('exige una URL http(s) válida', () => {
    expect(headerMediaProblem(true, '  ')).toBe('missing')
    expect(headerMediaProblem(true, 'ftp://x/y.jpg')).toBe('invalid')
    expect(headerMediaProblem(true, 'no es url')).toBe('invalid')
    expect(headerMediaProblem(true, 'https://x.com/a.jpg')).toBeNull()
  })
})

describe('storedHeaderMediaUrl', () => {
  it('lee audience_filter.headerMediaUrl', () => {
    expect(storedHeaderMediaUrl({ type: 'all', headerMediaUrl: ' https://x/a.jpg ' })).toBe('https://x/a.jpg')
  })
  it('null si no hay o no es texto', () => {
    expect(storedHeaderMediaUrl({ type: 'all' })).toBeNull()
    expect(storedHeaderMediaUrl({ headerMediaUrl: 3 })).toBeNull()
    expect(storedHeaderMediaUrl(null)).toBeNull()
  })
})

describe('pickResumeHeaderMediaUrl', () => {
  it('prioridad: diálogo, difusión, plantilla', () => {
    expect(pickResumeHeaderMediaUrl('https://d', 'https://b', 'https://t')).toBe('https://d')
    expect(pickResumeHeaderMediaUrl('', 'https://b', 'https://t')).toBe('https://b')
    expect(pickResumeHeaderMediaUrl(undefined, null, 'https://t')).toBe('https://t')
    expect(pickResumeHeaderMediaUrl(' ', null, undefined)).toBeNull()
  })
})
