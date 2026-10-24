import { describe, expect, it } from 'vitest'
import { checkLearnable, findPersonalData, hasPrice, redactSensitive } from './guards'

describe('hasPrice', () => {
  it.each([
    'Sale S/ 1,250.00 con instalación',
    'S/.350',
    'son 1500 soles',
    'unos 200 lucas',
    'cuesta 300',
    'el precio es bueno',
    'te hago un descuento',
    'le dimos 10% menos',
    'US$ 99',
    '$120',
    'cotización enviada',
    'quiere cotizar',
    'costo de envío',
    '50 dólares',
    'tiene presupuesto ajustado',
  ])('flags %s', (t) => {
    expect(hasPrice(t)).toBe(true)
  })

  it.each([
    'Busca una mesa de trabajo de acero',
    'Medidas: 120 x 60 x 90 cm',
    'Toldo para el sol en la terraza',
    'Restaurante en Miraflores',
    'Se le envió el catálogo',
    'Av. Los Olivos s/n',
  ])('passes %s', (t) => {
    expect(hasPrice(t)).toBe(false)
  })
})

describe('findPersonalData', () => {
  it('detects phones', () => {
    expect(findPersonalData('mi cel es 987 654 321')).toContain('phone')
    expect(findPersonalData('+51 987654321')).toContain('phone')
    expect(findPersonalData('fijo (01) 234-5678')).toContain('phone')
  })
  it('detects email, DNI, RUC and address', () => {
    expect(findPersonalData('escribe a juan.perez@mail.com')).toContain('email')
    expect(findPersonalData('DNI 45678912')).toContain('dni')
    expect(findPersonalData('RUC 20123456789')).toContain('ruc')
    expect(findPersonalData('RUC 20123456789')).not.toContain('phone')
    expect(findPersonalData('vivo en Av. Arequipa 1234')).toContain('address')
    expect(findPersonalData('Jr. Puno 455, Cercado')).toContain('address')
  })
  it('does not flag measurements or quantities', () => {
    expect(findPersonalData('150 200 300 cm')).toEqual([])
    expect(findPersonalData('necesita 12 mesas de 1.20 m')).toEqual([])
    expect(findPersonalData('cafetería, tono formal')).toEqual([])
  })
})

describe('checkLearnable', () => {
  it('ok for clean text', () => {
    expect(checkLearnable('Busca lavadero industrial de dos pozas')).toEqual({ ok: true, reasons: [] })
  })
  it('collects every reason', () => {
    const r = checkLearnable('precio S/ 300, llamar al 987654321')
    expect(r.ok).toBe(false)
    expect(r.reasons).toEqual(expect.arrayContaining(['price', 'phone']))
  })
})

describe('redactSensitive', () => {
  it('masks amounts and personal data, keeps the rest', () => {
    const out = redactSensitive(
      'Hola, quiero precio de una mesa 120x60, mi correo es a@b.com, cel 987 654 321, DNI 45678912, me dijeron S/ 500 o 1500 soles con 10% dscto',
    )
    expect(out).toContain('mesa 120x60')
    expect(out).toContain('[correo]')
    expect(out).toContain('[teléfono]')
    expect(out).toContain('[documento]')
    expect(out).toContain('[monto]')
    expect(out).not.toMatch(/987|45678912|500|1500|10%|a@b\.com/)
  })
  it('masks addresses', () => {
    expect(redactSensitive('envíen a Av. Arequipa 1234, Lince')).toContain('[dirección]')
  })
})
