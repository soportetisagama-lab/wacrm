import { describe, expect, it } from 'vitest'
import { checkLearnable, findPersonalData, hasAmount, hasBareFigure, hasPrice, redactSensitive } from './guards'

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

describe('amounts without currency in a price context', () => {
  it.each(['te lo dejo en 1200', 'sale a 350', 'me lo dejas en 800?', 'quedaría en 1,500', 'por 450 te lo llevas'])(
    'flags %s',
    (t) => {
      expect(hasPrice(t)).toBe(true)
      expect(hasAmount(t)).toBe(true)
    },
  )
  it.each(['llega en 15 días', 'a 30 minutos de Lima', 'una mesa de 120 cm', 'en 2 m de largo', 'para 150 personas'])(
    'passes %s',
    (t) => {
      expect(hasPrice(t)).toBe(false)
    },
  )
  it('redacts only the figure', () => {
    expect(redactSensitive('me lo dejas en 800 y la mesa de 120 cm')).toBe('me lo dejas en [monto] y la mesa de 120 cm')
    expect(redactSensitive('sale a 350 nomás')).toBe('sale a [monto] nomás')
  })
})

describe('hasBareFigure', () => {
  it.each(['pedido 4521', 'le ofrecieron 1200', 'código 1234567'])('flags %s', (t) => {
    expect(hasBareFigure(t)).toBe(true)
  })
  it.each(['120 x 60 x 90 cm', 'tanque de 500 litros', '200 unidades', '1500 mm', '2 mesas', 'cocina de 6 quemadores'])(
    'passes %s',
    (t) => {
      expect(hasBareFigure(t)).toBe(false)
    },
  )
})
