import { describe, it, expect, vi } from 'vitest'
import {
  NUMEROS_PRUEBA,
  celularNueveDigitos,
  debeDerivarCelular,
  derivarAuto,
  dentroDeHorario,
  derivacionSinHorario,
  horarioAbierto,
  procesarColaDerivacion,
  NOTA_EN_COLA,
  esNumeroExtranjero,
  celularDerivacion,
  type DerivacionStore,
} from './derivacion-auto'
import type { Clasificacion, ClasificadorDerivacion } from './derivacion-clasificar'

const ENV = { url: 'https://xlr8.test/derivar.php', secret: 's3cr3t', linea: 'LINEA_TEST' }

/** Hora de Lima (UTC-5, sin horario de verano). 2026-11-02 es lunes. */
function lima(isoLocal: string): Date {
  return new Date(`${isoLocal}:00-05:00`)
}

const DENTRO = lima('2026-11-02T10:00')

function makeStore(over: Partial<DerivacionStore> = {}, phone = '+51 926 843 129') {
  let claimed = false
  const queue = new Map<string, { at: Date; agente: string | null }>()
  const store: DerivacionStore = {
    loadConversation: vi.fn(async () => ({
      account_id: 'acc-1',
      channel: 'whatsapp',
      contact_id: 'ct-1',
      assigned_agent_id: null,
      status: 'pending',
    })),
    enqueue: vi.fn(async (id: string, at: Date, agente: string | null) => {
      if (claimed || queue.has(id)) return false
      queue.set(id, { at, agente })
      return true
    }),
    listQueue: vi.fn(async (limit: number) =>
      [...queue.entries()]
        .sort((a, b) => a[1].at.getTime() - b[1].at.getTime())
        .slice(0, limit)
        .map(([id]) => id),
    ),
    dequeue: vi.fn(async (id: string) => {
      const item = queue.get(id)
      if (!item) return null
      queue.delete(id)
      return { agente: item.agente }
    }),
    loadContact: vi.fn(async () => ({ phone, name: 'Ana' })),
    claim: vi.fn(async () => {
      if (claimed) return false
      claimed = true
      return true
    }),
    loadAdId: vi.fn(async () => '120210000000001'),
    findAgentByXlr8: vi.fn(async (_acc: string, id: number) => (id === 42 ? 'user-42' : null)),
    assign: vi.fn(async () => true),
    appendNote: vi.fn(async () => undefined),
    ...over,
  }
  return store
}

function okFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('número de prueba', () => {
  it('normaliza a 9 dígitos sin el 51', () => {
    expect(celularNueveDigitos('+51 926-843-129')).toBe('926843129')
    expect(celularNueveDigitos('926843129')).toBe('926843129')
    expect(celularNueveDigitos('')).toBeNull()
    expect(celularNueveDigitos('+1 202 555 0100')).toBeNull()
  })

  it('solo deja pasar los NUMEROS_PRUEBA', () => {
    expect(NUMEROS_PRUEBA).toEqual(['51926843129', '926843129'])
    expect(debeDerivarCelular('51926843129')).toBe(true)
    expect(debeDerivarCelular('926843129')).toBe(true)
    expect(debeDerivarCelular('+51 926 843 129')).toBe(true)
    expect(debeDerivarCelular('51999888777')).toBe(false)
    expect(debeDerivarCelular(null)).toBe(false)
  })

  it('otro número no reclama ni llama al PHP', async () => {
    const store = makeStore({}, '51999888777')
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('no_es_prueba')
    expect(store.claim).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('no deriva canales que no son WhatsApp', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({ account_id: 'acc-1', channel: 'instagram', contact_id: 'ct-1' })),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('no_whatsapp')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('sin variables de entorno', () => {
  it('no hace nada si falta la URL o el secreto', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: { secret: 'x' }, fetchFn, now: DENTRO })).toBe('sin_env')
    expect(await derivarAuto('conv-1', { store, env: { url: 'https://x', secret: ' ' }, fetchFn, now: DENTRO })).toBe('sin_env')
    expect(store.loadConversation).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('idempotencia', () => {
  it('llama al PHP una sola vez por conversación', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('asignada')
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('ya_derivada')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('si el PHP falla no reintenta', async () => {
    const store = makeStore()
    const fetchFn = vi.fn(async (): Promise<Response> => {
      throw new Error('timeout')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('error_php')
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('ya_derivada')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(store.assign).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('llamada y mapeo de asesor', () => {
  it('envía el payload y asigna al perfil con ese xlr8_user_id', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: '42', asesor_nombre: 'Luis Pérez' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('asignada')

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ENV.url)
    const headers = init.headers as Record<string, string>
    expect(headers['X-Derivar-Secret']).toBe('s3cr3t')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['User-Agent']).toBe('wacrm/1.0')
    expect(JSON.parse(init.body as string)).toEqual({
      linea: 'LINEA_TEST',
      celular: '926843129',
      nombre: 'Ana',
      codigo_anuncio: '120210000000001',
      conversation_id: 'conv-1',
      destino: 'ASESOR',
      motivo_atc: '',
    })
    expect(store.findAgentByXlr8).toHaveBeenCalledWith('acc-1', 42)
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', 'Derivado automáticamente a Luis Pérez (XLR8)')
  })

  it('sin perfil con ese ID deja la conversación sin asignar', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchFn = okFetch({ ok: true, asesor_id: 7, asesor_nombre: 'Rosa' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('sin_usuario')
    expect(store.assign).not.toHaveBeenCalled()
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', expect.stringContaining('queda sin asignar'))
    err.mockRestore()
  })

  it('duplicado con asesor_id asigna igual', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: false, motivo: 'duplicado', asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('asignada')
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
  })

  it('ok:false del PHP no asigna', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchFn = okFetch({ ok: false, motivo: 'sin_asesor' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('rechazada')
    expect(store.findAgentByXlr8).not.toHaveBeenCalled()
    expect(store.assign).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('HORARIO_DERIVACION', () => {
  it('lunes a viernes 08:00–17:00 sin el almuerzo 13:00–14:00', () => {
    expect(dentroDeHorario(lima('2026-11-02T07:59'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-02T08:00'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T12:59'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T13:00'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-02T13:59'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-02T14:00'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T16:59'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T17:00'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-06T16:59'))).toBe(true) // viernes
  })

  it('sábado 08:00–12:00', () => {
    expect(dentroDeHorario(lima('2026-11-07T07:59'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-07T08:00'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-07T11:59'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-07T12:00'))).toBe(false)
  })

  it('domingo nunca', () => {
    for (const h of ['00:00', '08:00', '10:00', '15:00', '20:00']) {
      expect(dentroDeHorario(lima('2026-11-08T' + h))).toBe(false)
    }
  })

  it('usa la hora de Lima aunque el servidor esté en UTC', () => {
    // 13:00 UTC = 08:00 Lima (lunes)
    expect(dentroDeHorario(new Date('2026-11-02T13:00:00Z'))).toBe(true)
    expect(dentroDeHorario(new Date('2026-11-02T12:59:00Z'))).toBe(false)
  })
})

describe('interruptor DERIVACION_SIN_HORARIO', () => {
  it('solo se activa con "true" (trim, minúsculas)', () => {
    expect(derivacionSinHorario('true')).toBe(true)
    expect(derivacionSinHorario('  TRUE ')).toBe(true)
    for (const v of [undefined, '', 'false', '1', 'si']) expect(derivacionSinHorario(v)).toBe(false)
  })

  it('horarioAbierto: activo siempre abre; si no, delega en dentroDeHorario', () => {
    const domingo = lima('2026-11-08T20:00')
    expect(horarioAbierto(domingo, undefined, true)).toBe(true)
    expect(horarioAbierto(domingo, undefined, false)).toBe(false)
    expect(horarioAbierto(DENTRO, undefined, false)).toBe(true)
  })

  it('con la variable activa no encola: deriva fuera de horario', async () => {
    vi.stubEnv('DERIVACION_SIN_HORARIO', 'true')
    try {
      const store = makeStore()
      const fetchFn = okFetch({ ok: true, asesor_id: 42 })
      await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-08T20:00') })
      expect(store.enqueue).not.toHaveBeenCalled()
      expect(fetchFn).toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('fuera de horario', () => {
  it('deja la conversación en cola, sin llamar al PHP, con la nota', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    const now = lima('2026-11-08T20:00')
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now })).toBe('en_cola')
    expect(store.enqueue).toHaveBeenCalledWith('conv-1', now, null)
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', NOTA_EN_COLA)
    expect(NOTA_EN_COLA).toBe('Se derivará automáticamente al abrir el horario')
    expect(store.claim).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    // Un segundo traspaso no la duplica.
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now })).toBe('ya_en_cola')
  })

  it('el número que no es de prueba no entra en la cola', async () => {
    const store = makeStore({}, '51999888777')
    const now = lima('2026-11-08T20:00')
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn: okFetch({}), now })).toBe('no_es_prueba')
    expect(store.enqueue).not.toHaveBeenCalled()
  })

  it('sin XLR8_LINEA no deriva ni encola, y lo registra', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const linea of [undefined, '  ']) {
      const env = { url: ENV.url, secret: ENV.secret, linea }
      expect(await derivarAuto('conv-1', { store, env, fetchFn, now: DENTRO })).toBe('sin_linea')
    }
    expect(err).toHaveBeenCalledWith('[derivacion-auto]', expect.stringContaining('XLR8_LINEA'), expect.anything())
    expect(store.loadConversation).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('cola de derivación', () => {
  it('domingo 20:00 espera y se deriva el lunes a las 08:00', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-08T20:00') })

    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T07:59') })).toEqual({
      derivadas: 0,
      descartadas: 0,
    })
    expect(store.listQueue).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()

    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T08:00') })).toEqual({
      derivadas: 1,
      descartadas: 0,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(await store.listQueue(10)).toEqual([])
  })

  it('13:20 espera y se deriva a las 14:00', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-03T13:20') })).toBe('en_cola')
    await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-03T13:59') })
    expect(fetchFn).not.toHaveBeenCalled()
    await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-03T14:00') })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('procesa la más antigua primero', async () => {
    const store = makeStore({ claim: vi.fn(async () => true) })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    await store.enqueue('nueva', lima('2026-11-08T21:00'), null)
    await store.enqueue('antigua', lima('2026-11-08T19:00'), null)
    await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T08:00') })
    const ids = (fetchFn.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => JSON.parse(init.body as string).conversation_id,
    )
    expect(ids).toEqual(['antigua', 'nueva'])
  })

  it('es idempotente: una conversación ya sacada de la cola no se deriva de nuevo', async () => {
    const store = makeStore({ dequeue: vi.fn(async () => null) })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    await store.enqueue('conv-1', lima('2026-11-08T20:00'), null)
    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO })).toEqual({
      derivadas: 0,
      descartadas: 0,
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('asignada por el propio traspaso (mismo asesor que al encolar) se deriva igual', async () => {
    const conv = {
      account_id: 'acc-1',
      channel: 'whatsapp',
      contact_id: 'ct-1',
      assigned_agent_id: 'user-7',
      status: 'pending',
    }
    const store = makeStore({ loadConversation: vi.fn(async () => conv) })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-08T20:00') })).toBe('en_cola')
    expect(store.enqueue).toHaveBeenCalledWith('conv-1', expect.any(Date), 'user-7')
    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO })).toEqual({
      derivadas: 1,
      descartadas: 0,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
  })

  it('si el asesor cambió después de encolar, sale de la cola sin derivar', async () => {
    const conv = {
      account_id: 'acc-1',
      channel: 'whatsapp',
      contact_id: 'ct-1',
      assigned_agent_id: 'user-7' as string | null,
      status: 'pending',
    }
    const store = makeStore({ loadConversation: vi.fn(async () => conv) })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-08T20:00') })
    conv.assigned_agent_id = 'user-9' // otro asesor la tomó en el CRM
    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO })).toEqual({
      derivadas: 0,
      descartadas: 1,
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('si un asesor ya la tomó, sale de la cola sin derivar', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({
        account_id: 'acc-1',
        channel: 'whatsapp',
        contact_id: 'ct-1',
        assigned_agent_id: 'user-9',
        status: 'open',
      })),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    await store.enqueue('conv-1', lima('2026-11-08T20:00'), null)
    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO })).toEqual({
      derivadas: 0,
      descartadas: 1,
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await store.listQueue(10)).toEqual([])
  })

  it('si ya no está pending/open, sale de la cola sin derivar', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({
        account_id: 'acc-1',
        channel: 'whatsapp',
        contact_id: 'ct-1',
        assigned_agent_id: null,
        status: 'closed',
      })),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    await store.enqueue('conv-1', lima('2026-11-08T20:00'), null)
    expect((await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO })).descartadas).toBe(1)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sin XLR8_LINEA la cola queda intacta', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.enqueue('conv-1', lima('2026-11-08T20:00'), null)
    const env = { url: ENV.url, secret: ENV.secret }
    await procesarColaDerivacion({ store, env, fetchFn: okFetch({}), now: DENTRO })
    expect(store.dequeue).not.toHaveBeenCalled()
    expect(await store.listQueue(10)).toEqual(['conv-1'])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('clasificación lead / ATC', () => {
  function bodyDe(fetchFn: ReturnType<typeof okFetch>) {
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    return JSON.parse(init.body as string) as Record<string, unknown>
  }
  const fijo = (c: Clasificacion) => vi.fn<ClasificadorDerivacion>(async () => c)

  it('lead → destino ASESOR y la nota de siempre', async () => {
    const store = makeStore()
    const clasificar = fijo({ tipo: 'lead', motivo: '' })
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, clasificar })).toBe('asignada')
    expect(clasificar).toHaveBeenCalledWith({ accountId: 'acc-1', conversationId: 'conv-1', numeroExtranjero: false })
    expect(bodyDe(fetchFn)).toMatchObject({ destino: 'ASESOR', motivo_atc: '' })
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', 'Derivado automáticamente a Luis (XLR8)')
  })

  it('busca trabajo → destino ATC con el motivo legible', async () => {
    const store = makeStore()
    const clasificar = fijo({ tipo: 'atc', motivo: 'trabajo' })
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Atención al cliente' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, clasificar })).toBe('asignada')
    expect(bodyDe(fetchFn)).toMatchObject({ destino: 'ATC', motivo_atc: 'Busca trabajo' })
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', 'Derivado automáticamente a ATC (Busca trabajo)')
  })

  it('número extranjero pidiendo para Perú → lead (lo decide la IA)', async () => {
    const store = makeStore()
    // La IA recibe numeroExtranjero=true como contexto y responde lead.
    const clasificar = fijo({ tipo: 'lead', motivo: '' })
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, clasificar })
    expect(bodyDe(fetchFn)).toMatchObject({ destino: 'ASESOR', motivo_atc: '' })
    expect(esNumeroExtranjero('+1 202 555 0100')).toBe(true)
    expect(esNumeroExtranjero('+51 926 843 129')).toBe(false)
    expect(esNumeroExtranjero('926843129')).toBe(false)
  })

  it('IA caída → lead, se registra y se llama al PHP igual', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clasificar = vi.fn<ClasificadorDerivacion>(async () => {
      throw new Error('insufficient_quota')
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, clasificar })).toBe('asignada')
    expect(bodyDe(fetchFn)).toMatchObject({ destino: 'ASESOR', motivo_atc: '' })
    expect(err).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('clasificación'), 'insufficient_quota', expect.anything())
    err.mockRestore()
  })

  it('fuera de horario no clasifica (lo hace la cola al derivar)', async () => {
    const store = makeStore()
    const clasificar = fijo({ tipo: 'atc', motivo: 'spam' })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-02T20:00'), clasificar })).toBe('en_cola')
    expect(clasificar).not.toHaveBeenCalled()
    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-03T08:00'), clasificar })).toEqual({
      derivadas: 1,
      descartadas: 0,
    })
    expect(bodyDe(fetchFn)).toMatchObject({ destino: 'ATC', motivo_atc: 'Spam' })
  })
})

describe('número extranjero', () => {
  it('se envía al PHP con todos sus dígitos internacionales, sin el +', () => {
    expect(celularDerivacion('+51 926 843 129')).toBe('926843129')
    expect(celularDerivacion('+1 202 555 0100')).toBe('12025550100')
    expect(celularDerivacion('+34 612 345 678')).toBe('34612345678')
    expect(celularDerivacion('12345678')).toBeNull()
    expect(celularDerivacion('1234567890123456')).toBeNull()
  })

  it('se deriva: la IA recibe extranjero=sí y, si pide para Perú, va como lead', async () => {
    const store = makeStore({}, '+1 202 555 0100')
    const clasificar = vi.fn<ClasificadorDerivacion>(async () => ({ tipo: 'lead', motivo: '' }))
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    const deps = { store, env: ENV, fetchFn, now: DENTRO, clasificar, numerosPrueba: ['12025550100'] }
    expect(await derivarAuto('conv-1', deps)).toBe('asignada')
    expect(clasificar).toHaveBeenCalledWith({ accountId: 'acc-1', conversationId: 'conv-1', numeroExtranjero: true })
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ celular: '12025550100', destino: 'ASESOR', motivo_atc: '' })
  })

  it('con menos de 9 dígitos queda sin_celular', async () => {
    const store = makeStore({}, '+1 555 0100')
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, numerosPrueba: ['15550100'] })).toBe('sin_celular')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('el modo prueba sigue cerrado a otros números extranjeros', async () => {
    const store = makeStore({}, '+1 202 555 0100')
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('no_es_prueba')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
