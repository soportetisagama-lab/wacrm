import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildBusinessInfoBlock,
  extractMenuAnswers,
  loadBusinessInfo,
  menuTextHasPrice,
  resetBusinessInfoCache,
} from './business-info'
import { buildSystemPrompt } from './defaults'

const LOCATION =
  '📍 Nos ubicamos en Av. Ejemplo 12345, Urb. Modelo, Lima. Atendemos de lunes a viernes de 8:00 a 18:00 y sábados de 9:00 a 13:00.'

const welcomeNodes = [
  {
    node_key: 'menu',
    node_type: 'send_list',
    config: {
      text: '¡Hola! ¿En qué te ayudamos?',
      button_label: 'Ver opciones',
      sections: [
        {
          rows: [
            { reply_id: 'loc', title: 'Ubicación y horario', next_node_key: 'answer_location' },
            { reply_id: 'pay', title: 'Medios de pago', next_node_key: 'answer_pay' },
            { reply_id: 'price', title: 'Lista de precios', next_node_key: 'answer_price' },
            { reply_id: 'adv', title: 'Hablar con un asesor', next_node_key: 'handoff' },
          ],
        },
      ],
    },
  },
  { node_key: 'answer_location', node_type: 'send_message', config: { text: LOCATION, next_node_key: 'end' } },
  {
    node_key: 'answer_pay',
    node_type: 'send_message',
    config: { text: 'Aceptamos transferencia y tarjetas.', next_node_key: 'answer_pay_2' },
  },
  {
    node_key: 'answer_pay_2',
    node_type: 'send_message',
    config: { text: 'Hola {{vars.name}}, también Yape.', next_node_key: 'end' },
  },
  {
    node_key: 'answer_price',
    node_type: 'send_message',
    config: { text: 'Nuestras ollas desde S/ 120.', next_node_key: 'end' },
  },
  { node_key: 'handoff', node_type: 'handoff', config: {} },
  { node_key: 'end', node_type: 'end', config: {} },
]

describe('menuTextHasPrice', () => {
  it('does not treat opening hours or a street number as a price', () => {
    expect(menuTextHasPrice(LOCATION)).toBe(false)
    expect(menuTextHasPrice('Atendemos de 9 a 6 pm, a 2 cuadras del parque.')).toBe(false)
    expect(menuTextHasPrice('Lunes a sábado de 9 a 18 y domingos de 10 a 13.')).toBe(false)
    expect(menuTextHasPrice('Envíos a todo Lima en 24 a 48 horas.')).toBe(false)
    expect(menuTextHasPrice('Domingos de 10 a 15 soles')).toBe(true)
    expect(
      menuTextHasPrice(
        '📍 Nos ubicamos en Av. Nicolás Ayllón 11654, Gloria Alta, Ate, Lima. Atendemos de lunes a viernes de 8:00 a.m. a 5:00 p.m. y sábados de 8:30 a.m. a 12:30 p.m. Hacemos envíos a todo el Perú con embalaje reforzado.',
      ),
    ).toBe(false)
    expect(menuTextHasPrice('Mz. B Lt. 5, llámanos al 987 654 321. Atención 24/7.')).toBe(false)
    expect(menuTextHasPrice('1️⃣ Ubicación')).toBe(false)
  })

  it('treats any unexplained figure as a price without currency', () => {
    for (const t of [
      'Ollas desde 1200',
      'desde 1,200',
      'a partir de 1200',
      'pedido mínimo 500',
      'Envío gratis desde 300',
      'Delivery 15',
      'Ollas 1200',
    ]) {
      expect(menuTextHasPrice(t), t).toBe(true)
    }
  })

  it('catches currencies, amounts and price words', () => {
    for (const t of [
      'Desde S/ 120',
      'Cuesta 150 soles',
      'Envío gratis por compras sobre $50',
      'Precio especial esta semana',
      'El costo del envío depende de la zona',
      '20 USD',
      'Te lo dejamos en 1,200',
      '10% de descuento',
    ]) {
      expect(menuTextHasPrice(t), t).toBe(true)
    }
  })
})

describe('extractMenuAnswers', () => {
  it('maps each option that leads to a send_message to title: text, following short chains', () => {
    const answers = extractMenuAnswers(welcomeNodes)
    expect(answers).toEqual([
      { title: 'Ubicación y horario', text: LOCATION },
      { title: 'Medios de pago', text: 'Aceptamos transferencia y tarjetas. Hola, también Yape.' },
      { title: 'Lista de precios', text: 'Nuestras ollas desde S/ 120.' },
    ])
  })

  it('reads buttons too and survives malformed configs and loops', () => {
    const answers = extractMenuAnswers([
      {
        node_key: 'b',
        node_type: 'send_buttons',
        config: { text: 'x', buttons: [{ reply_id: '1', title: 'Horario', next_node_key: 'm' }, null] },
      },
      { node_key: 'm', node_type: 'send_message', config: { text: 'Lunes a sábado.', next_node_key: 'm' } },
      { node_key: 'bad', node_type: 'send_list', config: { sections: 'nope' } },
      { node_key: 'bad2', node_type: 'send_buttons', config: null },
    ])
    expect(answers).toEqual([{ title: 'Horario', text: 'Lunes a sábado.' }])
  })
})

describe('buildBusinessInfoBlock', () => {
  it('leaves out every answer with a price and keeps the rest', () => {
    const block = buildBusinessInfoBlock(extractMenuAnswers(welcomeNodes))
    expect(block).toContain(`- Ubicación y horario: ${LOCATION}`)
    expect(block).toContain('- Medios de pago:')
    expect(block).not.toContain('S/')
    expect(block).not.toContain('precios')
  })

  it('drops an option whose title is about prices', () => {
    expect(buildBusinessInfoBlock([{ title: 'Cotizar', text: 'Cuéntanos qué necesitas.' }])).toBeNull()
  })

  it('dedupes the same answer under several options, merging titles', () => {
    const block = buildBusinessInfoBlock([
      { title: 'Ubicación', text: 'Av. Ejemplo 1, Lima.' },
      { title: 'Dirección', text: 'Av. Ejemplo 1, Lima.' },
      { title: 'Ubicación', text: 'Av.  Ejemplo 1, Lima.' },
    ])
    expect(block).toBe('- Ubicación / Dirección: Av. Ejemplo 1, Lima.')
  })

  it('respects the size cap and returns null when empty', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `Opción ${i}`, text: 'x'.repeat(200) + i }))
    const block = buildBusinessInfoBlock(many, 1000) ?? ''
    expect(block.length).toBeLessThanOrEqual(1000)
    expect(block.length).toBeGreaterThan(0)
    expect(buildBusinessInfoBlock([])).toBeNull()
  })
})

describe('loadBusinessInfo', () => {
  beforeEach(() => resetBusinessInfoCache())

  function fakeDb(nodes: unknown[], calls: string[]): SupabaseClient {
    const chain = (table: string) => {
      const c = {
        select: () => c,
        eq: () => c,
        order: () => Promise.resolve({ data: [{ id: 'f1' }], error: null }),
        in: () => Promise.resolve({ data: nodes, error: null }),
      }
      calls.push(table)
      return c
    }
    return { from: chain } as unknown as SupabaseClient
  }

  it('builds the block from active flows and caches it per account', async () => {
    const calls: string[] = []
    const db = fakeDb(welcomeNodes.map((n) => ({ ...n, flow_id: 'f1' })), calls)
    const first = await loadBusinessInfo(db, 'acc', 1_000)
    expect(first).toContain('Ubicación y horario')
    const second = await loadBusinessInfo(db, 'acc', 2_000)
    expect(second).toBe(first)
    expect(calls).toEqual(['flows', 'flow_nodes'])
    await loadBusinessInfo(db, 'acc', 1_000 + 6 * 60 * 1000)
    expect(calls).toHaveLength(4)
  })

  it('returns null on a DB error without throwing', async () => {
    const db = {
      from: () => {
        throw new Error('boom')
      },
    } as unknown as SupabaseClient
    await expect(loadBusinessInfo(db, 'acc2')).resolves.toBeNull()
  })
})

describe('buildSystemPrompt with businessInfo', () => {
  it('adds the menu answers block with the answer-directly instruction', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Tienda de prueba',
      mode: 'auto_reply',
      businessInfo: `- Ubicación y horario: ${LOCATION}`,
    })
    expect(prompt).toContain('Información del negocio (respuestas del menú)')
    expect(prompt).toContain(LOCATION)
    expect(prompt).toContain('instead of offering an advisor')
    // The no-prices rule still closes the prompt.
    expect(prompt.trimEnd().endsWith('(do not hand off just for that).')).toBe(true)
  })

  it('adds nothing when there is no menu info', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', businessInfo: null })
    expect(prompt).not.toContain('respuestas del menú')
  })
})
