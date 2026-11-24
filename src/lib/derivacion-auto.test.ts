import { describe, it, expect, vi } from 'vitest'
import {
  NUMEROS_PRUEBA,
  celularNueveDigitos,
  debeDerivarCelular,
  numeroSeDerivara,
  derivarAuto,
  dentroDeHorario,
  derivacionSinHorario,
  horarioAbierto,
  procesarColaDerivacion,
  barrerSinCola,
  NOTA_EN_COLA,
  NOTA_EN_ESPERA,
  NOTA_EN_TURNO,
  esNumeroExtranjero,
  origenGoogle,
  celularDerivacion,
  conservarNotasDerivacion,
  derivacionConfigurada,
  HORARIO_DERIVACION,
  NOTA_ERROR_PHP,
  reiniciarReintentosPhp,
  derivarExtranjeroSiParaPeru,
  atcExtranjeroDe,
  NOTA_EXTRANJERO_PERU,
  type DerivacionStore,
} from './derivacion-auto'
import type { Clasificacion, ClasificadorDerivacion } from './derivacion-clasificar'

const ENV = { url: 'https://xlr8.test/derivar.php', secret: 's3cr3t', linea: 'LINEA_TEST' }

/** Hora de Lima (UTC-5, sin horario de verano). 2026-11-02 es lunes. */
function lima(isoLocal: string): Date {
  return new Date(`${isoLocal}:00-05:00`)
}

const DENTRO = lima('2026-11-02T10:00')

/** Lista de modo prueba explícita para los tests que verifican el filtro. */
const PRUEBA: readonly string[] = ['51926843129', '926843129']

function makeStore(over: Partial<DerivacionStore> = {}, phone = '+51 926 843 129') {
  let claimed = false
  const queue = new Map<string, { at: Date; agente: string | null }>()
  const notas = new Map<string, string[]>()
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
    requeue: vi.fn(async (id: string, at: Date, agente: string | null) => {
      claimed = false
      queue.set(id, { at, agente })
      return true
    }),
    hasPendingQueue: vi.fn(async (exclude: string) => [...queue.keys()].some((id) => id !== exclude)),
    saveClasificacion: vi.fn(async () => undefined),
    listQueue: vi.fn(async (limit: number) =>
      [...queue.entries()]
        .sort((a, b) => a[1].at.getTime() - b[1].at.getTime())
        .slice(0, limit)
        .map(([id, { at }]) => ({ id, at })),
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
    // Como el store real: no repite una línea que ya está en la nota.
    appendNote: vi.fn(async (id: string, line: string) => {
      const actual = notas.get(id) ?? []
      if (!actual.includes(line)) notas.set(id, [...actual, line])
    }),
    ...over,
  }
  return Object.assign(store, { notas, colaIds: async () => (await store.listQueue(100)).map((c) => c.id) })
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
    // Lista vacía: cualquier celular pasa.
    expect(NUMEROS_PRUEBA).toEqual([])
    expect(debeDerivarCelular('51999888777')).toBe(true)
    expect(debeDerivarCelular('+1 202 555 0100')).toBe(true)
    expect(debeDerivarCelular(null)).toBe(false)
    expect(debeDerivarCelular('')).toBe(false)
    // Con una lista explícita sigue filtrando.
    const lista = ['51926843129', '926843129']
    expect(debeDerivarCelular('51926843129', lista)).toBe(true)
    expect(debeDerivarCelular('926843129', lista)).toBe(true)
    expect(debeDerivarCelular('+51 926 843 129', lista)).toBe(true)
    expect(debeDerivarCelular('51999888777', lista)).toBe(false)
    expect(debeDerivarCelular(null, lista)).toBe(false)
  })

  it('otro número no reclama ni llama al PHP', async () => {
    const store = makeStore({}, '51999888777')
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, numerosPrueba: PRUEBA })).toBe('no_es_prueba')
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

  it('si el PHP falla vuelve a la cola y se reintenta siempre', async () => {
    reiniciarReintentosPhp()
    const store = makeStore()
    const fetchFn = vi.fn(async (): Promise<Response> => {
      throw new Error('timeout')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('reintento_php')
    expect(await store.colaIds()).toEqual(['conv-1'])
    expect(store.assign).not.toHaveBeenCalled()
    // Sigue fallando: nunca sale de la cola ni deja la nota de "a mano".
    for (let i = 1; i < 30; i++) {
      await store.dequeue('conv-1')
      expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO }, { desdeCola: { at: DENTRO } })).toBe('reintento_php')
    }
    expect(store.notas.get('conv-1') ?? []).not.toContain(NOTA_ERROR_PHP)
    expect(await store.colaIds()).toEqual(['conv-1'])
    err.mockRestore()
  })

  it('respuesta sin motivo o página de login: vuelve a la cola', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const fetchFn of [
      okFetch({ ok: false }),
      vi.fn(async () => new Response('<html>login</html>', { status: 200 })),
      okFetch({ ok: false, motivo: 'no_autorizado' }),
    ]) {
      const store = makeStore()
      expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('reintento_php')
      expect(await store.colaIds()).toEqual(['conv-1'])
      expect(store.assign).not.toHaveBeenCalled()
    }
    err.mockRestore()
  })

  it('HTTP 520 del XLR8: reintenta y luego deriva', async () => {
    reiniciarReintentosPhp()
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const caido = vi.fn(async () => new Response('<html>520</html>', { status: 520 }))
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn: caido, now: DENTRO })).toBe('reintento_php')
    await store.dequeue('conv-1')
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO }, { desdeCola: { at: DENTRO } })).toBe('asignada')
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
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
      historico: false,
      origen_google: '',
      espera_desde: '2026-11-02T15:00:00.000Z',
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

  it('alerta_atc: no asigna, deja nota y no vuelve a la cola', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: false, motivo: 'alerta_atc', asesor_id: 42, asesor_nombre: 'Luis', fecha_registro: '01/09/2026' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('alerta_atc')
    expect(store.assign).not.toHaveBeenCalled()
    expect(store.requeue).not.toHaveBeenCalled()
    expect(store.notas.get('conv-1')?.[0]).toContain('Alerta para ATC: cliente de Luis (último registro el 01/09/2026)')
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('ya_derivada')
  })

  it('ok:false del PHP (otro motivo) no asigna ni vuelve a la cola', async () => {
    for (const motivo of ['sin_celular', 'fuera_de_prueba', 'duplicado']) {
      const store = makeStore()
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetchFn = okFetch({ ok: false, motivo })
      expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('rechazada')
      expect(store.findAgentByXlr8).not.toHaveBeenCalled()
      expect(store.assign).not.toHaveBeenCalled()
      expect(store.requeue).not.toHaveBeenCalled()
      expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('ya_derivada')
      err.mockRestore()
    }
  })
})

describe('HORARIO_DERIVACION', () => {
  it('lunes a jueves 08:00–17:00 sin el almuerzo 12:45–14:00', () => {
    expect(dentroDeHorario(lima('2026-11-02T07:59'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-02T08:00'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T12:44'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T12:45'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-02T13:59'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-02T14:00'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T16:59'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-02T17:00'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-05T17:00'))).toBe(false) // jueves
  })

  it('viernes 08:00–17:30', () => {
    expect(dentroDeHorario(lima('2026-11-06T12:45'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-06T17:29'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-06T17:30'))).toBe(false)
  })

  it('sábado 08:00–12:30', () => {
    expect(dentroDeHorario(lima('2026-11-07T07:59'))).toBe(false)
    expect(dentroDeHorario(lima('2026-11-07T08:00'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-07T12:29'))).toBe(true)
    expect(dentroDeHorario(lima('2026-11-07T12:30'))).toBe(false)
  })

  it('feriado como domingo solo con FERIADOS_PAUSAN_DERIVACION=1', () => {
    // 2026-12-08 (martes) es feriado.
    expect(dentroDeHorario(lima('2026-12-08T10:00'))).toBe(true)
    vi.stubEnv('FERIADOS_PAUSAN_DERIVACION', '1')
    expect(dentroDeHorario(lima('2026-12-08T10:00'))).toBe(false)
    expect(dentroDeHorario(lima('2026-12-10T10:00'))).toBe(true)
    vi.unstubAllEnvs()
    const conFeriado = { ...HORARIO_DERIVACION, esFeriado: (f: string) => f === '2026-11-02' }
    expect(dentroDeHorario(lima('2026-11-02T10:00'), conFeriado)).toBe(false)
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
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn: okFetch({}), now, numerosPrueba: PRUEBA })).toBe('no_es_prueba')
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
  it('antesDeDerivar (plantilla) corre antes de llamar al PHP', async () => {
    const store = makeStore()
    await store.enqueue('conv-1', lima('2026-11-15T17:00'), null)
    const orden: string[] = []
    const fetchFn = vi.fn(async () => {
      orden.push('php')
      return new Response(JSON.stringify({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const antesDeDerivar = vi.fn(async () => {
      orden.push('plantilla')
    })
    const r = await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-17T10:00'), antesDeDerivar })
    expect(r.derivadas).toBe(1)
    expect(antesDeDerivar).toHaveBeenCalledWith('conv-1')
    expect(orden).toEqual(['plantilla', 'php'])
  })

  it('barrido: encola los chats sin asesor que nunca entraron a la cola', async () => {
    const store = makeStore()
    const viejo = lima('2026-11-14T19:04')
    store.listSinCola = vi.fn(async () => [{ id: 'conv-1', at: viejo }])
    expect(await barrerSinCola(store, lima('2026-11-17T10:00'))).toBe(1)
    // Abiertos con la IA: solo los quietos hace 2 h o más.
    expect(store.listSinCola).toHaveBeenCalledWith(expect.any(Date), 100, lima('2026-11-17T08:00'))
    expect(store.enqueue).toHaveBeenCalledWith('conv-1', viejo, null)
    expect(await store.colaIds()).toEqual(['conv-1'])
    // Ya en cola: no se duplica.
    expect(await barrerSinCola(store, lima('2026-11-17T10:10'))).toBe(0)
  })

  it('domingo 20:00 espera y se deriva el lunes a las 08:00', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-08T20:00') })

    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T07:59') })).toEqual({
      derivadas: 0,
      descartadas: 0,
      enEspera: 0,
    })
    expect(store.listQueue).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()

    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T08:00') })).toEqual({
      derivadas: 1,
      descartadas: 0,
      enEspera: 0,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(await store.colaIds()).toEqual([])
  })

  it('excepción tras reclamar: vuelve a la cola con su asesor y luego se deriva', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = store.loadConversation
    store.loadConversation = vi.fn(async (id: string) => {
      const c = await base(id)
      return c ? { ...c, assigned_agent_id: 'user-9' } : c
    })
    const original = store.findAgentByXlr8
    store.findAgentByXlr8 = vi.fn(async () => {
      throw new Error('boom')
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: lima('2026-11-09T09:00') })).toBe('reintento_php')
    expect(await store.colaIds()).toEqual(['conv-1'])
    store.findAgentByXlr8 = original
    const r = await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T09:01') })
    expect(r.descartadas).toBe(0)
    expect(r.derivadas).toBe(1)
    err.mockRestore()
  })

  it('asesor_ausente: espera a su asesor al final de la cola sin frenar al siguiente', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.enqueue('suyo', lima('2026-11-09T07:00'), null)
    await store.enqueue('normal', lima('2026-11-09T07:30'), null)
    let n = 0
    const fetchFn = vi.fn(async () => {
      n++
      return new Response(
        JSON.stringify(
          n === 1
            ? { ok: false, motivo: 'asesor_ausente', asesor_id: 42, asesor_nombre: 'Miguel' }
            : { ok: true, asesor_id: 42, asesor_nombre: 'Luis' },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const r = await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T09:00') })
    expect(r.derivadas).toBe(1)
    expect(store.assign).toHaveBeenCalledTimes(1)
    expect(store.assign).toHaveBeenCalledWith('normal', 'user-42')
    expect(await store.colaIds()).toEqual(['suyo'])
    expect(store.notas.get('suyo')?.join(' ')).toContain('En espera de su asesor Miguel')
    err.mockRestore()
  })

  it('sin_atc vuelve al final y no frena al siguiente en la misma pasada', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.enqueue('atc', lima('2026-11-09T07:00'), null)
    await store.enqueue('normal', lima('2026-11-09T07:30'), null)
    let n = 0
    const fetchFn = vi.fn(async () => {
      n++
      return new Response(
        JSON.stringify(n === 1 ? { ok: false, motivo: 'sin_atc' } : { ok: true, asesor_id: 42, asesor_nombre: 'Luis' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const r = await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-09T09:00') })
    expect(r.derivadas).toBe(1)
    expect(store.assign).toHaveBeenCalledWith('normal', 'user-42')
    expect(await store.colaIds()).toEqual(['atc'])
    err.mockRestore()
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
      enEspera: 0,
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
      enEspera: 0,
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
      enEspera: 0,
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
      enEspera: 0,
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await store.colaIds()).toEqual([])
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
    expect(await store.colaIds()).toEqual(['conv-1'])
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

  it('origenGoogle: lee el primer mensaje del cliente', () => {
    expect(origenGoogle('Te escribo desde Google')).toBe('Seo')
    expect(origenGoogle('Hola, le escribo desde su página de Google https://sagama-retail.com/')).toBe('Seo')
    expect(origenGoogle('Hola, vi su anuncio de Google')).toBe('Anuncio')
    expect(origenGoogle('Quiero visitar la planta de producción')).toBe('')
    expect(origenGoogle(null)).toBe('')
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
      enEspera: 0,
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
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, numerosPrueba: PRUEBA })).toBe('no_es_prueba')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('cupo lleno (en_espera)', () => {
  const conv = (over: Record<string, unknown> = {}) => ({
    account_id: 'acc-1',
    channel: 'whatsapp',
    contact_id: 'ct-1',
    assigned_agent_id: null,
    status: 'pending',
    ...over,
  })

  it('traspaso en vivo con sin_asesor: deshace el reclamo y entra a la cola con now', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: false, motivo: 'sin_asesor' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('en_espera')
    expect(store.requeue).toHaveBeenCalledWith('conv-1', DENTRO, null)
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', NOTA_EN_ESPERA)
    expect(NOTA_EN_ESPERA).toBe('En espera: todos los asesores tienen el cupo lleno')
    expect(store.assign).not.toHaveBeenCalled()
    expect(await store.colaIds()).toEqual(['conv-1'])
  })

  it('HTTP 503 (ocupado) también vuelve a la cola, con o sin JSON', async () => {
    for (const fetchFn of [
      okFetch({ ok: false, motivo: 'ocupado' }, 503),
      vi.fn(async () => new Response('Service Unavailable', { status: 503 })),
    ]) {
      const store = makeStore()
      expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('en_espera')
      expect(await store.colaIds()).toEqual(['conv-1'])
    }
  })

  it('HTTP 429 con cuerpo HTML (límite del hosting) vuelve a la cola y no queda reclamada', async () => {
    const store = makeStore()
    const fetchFn = vi.fn(
      async () =>
        new Response('<html><body><h1>429 Too Many Requests</h1></body></html>', {
          status: 429,
          headers: { 'Content-Type': 'text/html' },
        }),
    )
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('en_espera')
    expect(store.requeue).toHaveBeenCalledWith('conv-1', DENTRO, null)
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', NOTA_EN_ESPERA)
    expect(store.assign).not.toHaveBeenCalled()
    expect(await store.colaIds()).toEqual(['conv-1'])
  })

  it('HTTP 429 desde la cola: conserva su hora, nota una sola vez y corta la pasada', async () => {
    const store = makeStore()
    const llegada = lima('2026-11-02T07:30')
    await store.enqueue('conv-1', llegada, null)
    await store.enqueue('conv-2', lima('2026-11-02T07:40'), null)
    const fetchFn = vi.fn(async () => new Response('<html>Too Many Requests</html>', { status: 429 }))
    for (const hora of ['10:00', '10:01']) {
      expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima(`2026-11-02T${hora}`) })).toEqual({
        derivadas: 0,
        descartadas: 0,
        enEspera: 1,
      })
      expect(store.requeue).toHaveBeenLastCalledWith('conv-1', llegada, null)
    }
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(store.notas.get('conv-1')).toEqual([NOTA_EN_ESPERA])
  })

  it('desde la cola vuelve con su hora original y la nota se escribe una sola vez', async () => {
    const store = makeStore()
    const llegada = lima('2026-11-02T07:30')
    await store.enqueue('conv-1', llegada, null)
    const fetchFn = okFetch({ ok: false, motivo: 'sin_asesor' })
    for (const hora of ['10:00', '10:01', '10:02']) {
      expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima(`2026-11-02T${hora}`) })).toEqual({
        derivadas: 0,
        descartadas: 0,
        enEspera: 1,
      })
      expect(store.requeue).toHaveBeenLastCalledWith('conv-1', llegada, null)
    }
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(store.notas.get('conv-1')).toEqual([NOTA_EN_ESPERA])

    // Se libera un cupo: la siguiente pasada la deriva.
    const ok = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn: ok, now: lima('2026-11-02T10:03') })).toEqual({
      derivadas: 1,
      descartadas: 0,
      enEspera: 0,
    })
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(await store.colaIds()).toEqual([])
  })

  it('corta la pasada: no llama al PHP por las siguientes', async () => {
    const store = makeStore({ claim: vi.fn(async () => true) })
    await store.enqueue('a', lima('2026-11-02T07:00'), null)
    await store.enqueue('b', lima('2026-11-02T07:10'), null)
    await store.enqueue('c', lima('2026-11-02T07:20'), null)
    const fetchFn = okFetch({ ok: false, motivo: 'sin_asesor' })
    const clasificar = vi.fn<ClasificadorDerivacion>(async () => ({ tipo: 'lead', motivo: '' }))
    expect(await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO, clasificar })).toEqual({
      derivadas: 0,
      descartadas: 0,
      enEspera: 1,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(clasificar).toHaveBeenCalledTimes(1)
    expect(await store.colaIds()).toEqual(['a', 'b', 'c'])
  })

  it('reutiliza la clasificación guardada (no vuelve a llamar a la IA)', async () => {
    const guardada: { valor: unknown } = { valor: null }
    const store = makeStore({
      loadConversation: vi.fn(async () => conv({ derivacion_clasificacion: guardada.valor })),
      saveClasificacion: vi.fn(async (_id: string, c: Clasificacion) => {
        guardada.valor = c
      }),
    })
    const clasificar = vi.fn<ClasificadorDerivacion>(async () => ({ tipo: 'atc', motivo: 'proveedor' }))
    const lleno = okFetch({ ok: false, motivo: 'sin_asesor' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn: lleno, now: DENTRO, clasificar })).toBe('en_espera')
    expect(store.saveClasificacion).toHaveBeenCalledWith('conv-1', { tipo: 'atc', motivo: 'proveedor' })

    const ok = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'ATC' })
    await procesarColaDerivacion({ store, env: ENV, fetchFn: ok, now: lima('2026-11-02T10:01'), clasificar })
    expect(clasificar).toHaveBeenCalledTimes(1)
    const [, init] = ok.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ destino: 'ATC', motivo_atc: 'Proveedor' })
  })

  it('si la IA falla no guarda la clasificación (se reintenta clasificar)', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clasificar = vi.fn<ClasificadorDerivacion>(async () => {
      throw new Error('timeout')
    })
    await derivarAuto('conv-1', { store, env: ENV, fetchFn: okFetch({ ok: true, asesor_id: 42 }), now: DENTRO, clasificar })
    expect(store.saveClasificacion).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('orden estricto', () => {
  it('con cola no vacía, el traspaso en vivo entra a la cola con now y no llama al PHP', async () => {
    const store = makeStore({ claim: vi.fn(async () => true) })
    await store.enqueue('antigua', lima('2026-11-02T07:00'), null)
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('nueva', { store, env: ENV, fetchFn, now: DENTRO })).toBe('en_cola')
    expect(store.enqueue).toHaveBeenLastCalledWith('nueva', DENTRO, null)
    expect(store.appendNote).toHaveBeenCalledWith('nueva', NOTA_EN_TURNO)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await store.colaIds()).toEqual(['antigua', 'nueva'])

    await procesarColaDerivacion({ store, env: ENV, fetchFn, now: lima('2026-11-02T10:01') })
    const ids = (fetchFn.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => JSON.parse(init.body as string).conversation_id,
    )
    expect(ids).toEqual(['antigua', 'nueva'])
  })

  it('con la cola vacía se deriva directo como siempre', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('asignada')
    expect(store.hasPendingQueue).toHaveBeenCalledWith('conv-1')
    expect(store.enqueue).not.toHaveBeenCalled()
  })
})

describe('histórico', () => {
  it('derivacion_historica = true envía historico: true al PHP', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({
        account_id: 'acc-1',
        channel: 'whatsapp',
        contact_id: 'ct-1',
        assigned_agent_id: null,
        status: 'pending',
        derivacion_historica: true,
      })),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    await store.enqueue('conv-1', lima('2026-11-01T09:00'), null)
    await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO })
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ conversation_id: 'conv-1', historico: true })
  })
})

describe('numeroSeDerivara (número que llega tras el traspaso)', () => {
  const env = { url: 'https://x.test/derivar', secret: 's', linea: 'INOX' }
  const prueba = ['51926843129', '926843129']

  it('true: variables configuradas y número permitido por el MODO PRUEBA', () => {
    expect(numeroSeDerivara('51926843129', env, prueba)).toBe(true)
    expect(numeroSeDerivara('+51 926 843 129', env, prueba)).toBe(true)
  })

  it('false: el MODO PRUEBA no permite el número (se reinicia la bienvenida)', () => {
    expect(numeroSeDerivara('51999888777', env, prueba)).toBe(false)
  })

  it('false: faltan DERIVAR_AUTO_URL, DERIVAR_AUTO_SECRET o XLR8_LINEA', () => {
    expect(numeroSeDerivara('51926843129', { ...env, url: '' }, prueba)).toBe(false)
    expect(numeroSeDerivara('51926843129', { ...env, secret: undefined }, prueba)).toBe(false)
    expect(numeroSeDerivara('51926843129', { ...env, linea: ' ' }, prueba)).toBe(false)
  })

  it('false: sin número o con un celular inválido', () => {
    expect(numeroSeDerivara(null, env, prueba)).toBe(false)
    expect(numeroSeDerivara('12345', env, ['12345'])).toBe(false)
  })
})

describe('derivación desde el webhook (soloSinAsesor)', () => {
  it('no toca un chat que ya tiene asesor', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({
        account_id: 'acc-1',
        channel: 'whatsapp',
        contact_id: 'ct-1',
        assigned_agent_id: 'user-7',
        status: 'open',
      })),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO }, { soloSinAsesor: true })).toBe(
      'con_asesor',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sin asesor deriva normal', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO }, { soloSinAsesor: true })).toBe(
      'asignada',
    )
  })

  it('el perfil "@" (chat sin número) cuenta como sin asesor: deriva y asigna al asesor real', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({
        account_id: 'acc-1',
        channel: 'whatsapp',
        contact_id: 'ct-1',
        assigned_agent_id: 'perfil-arroba',
        status: 'open',
      })),
      esPerfilSinNumero: vi.fn(async (id: string) => id === 'perfil-arroba'),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO }, { soloSinAsesor: true })).toBe(
      'asignada',
    )
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
  })

  it('un asesor real sigue sin tocarse aunque el store sepa de "@"', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({
        account_id: 'acc-1',
        channel: 'whatsapp',
        contact_id: 'ct-1',
        assigned_agent_id: 'user-7',
        status: 'open',
      })),
      esPerfilSinNumero: vi.fn(async (id: string) => id === 'perfil-arroba'),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO }, { soloSinAsesor: true })).toBe(
      'con_asesor',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('conservarNotasDerivacion', () => {
  it('agrega al resumen nuevo las notas de derivación que había', () => {
    const anterior = 'Hola' + '\n' + 'Derivado automáticamente a Luis (XLR8)'
    expect(conservarNotasDerivacion(anterior, 'Resumen del bot')).toBe(
      'Resumen del bot' + '\n' + 'Derivado automáticamente a Luis (XLR8)',
    )
    expect(conservarNotasDerivacion(NOTA_EN_COLA, 'R')).toBe('R' + '\n' + NOTA_EN_COLA)
  })

  it('no repite ni agrega otras líneas', () => {
    expect(conservarNotasDerivacion('Otra cosa', 'R')).toBe('R')
    expect(conservarNotasDerivacion(null, 'R')).toBe('R')
    expect(conservarNotasDerivacion(NOTA_EN_ESPERA, 'R' + '\n' + NOTA_EN_ESPERA)).toBe('R' + '\n' + NOTA_EN_ESPERA)
  })
})

describe('derivacionConfigurada', () => {
  it('true con URL, secreto y línea', () => {
    expect(derivacionConfigurada(ENV)).toBe(true)
  })
  it('false si falta cualquiera', () => {
    expect(derivacionConfigurada({ ...ENV, url: '' })).toBe(false)
    expect(derivacionConfigurada({ ...ENV, secret: undefined })).toBe(false)
    expect(derivacionConfigurada({ ...ENV, linea: ' ' })).toBe(false)
  })
})

describe('cliente con asesor en XLR8 (regla de los 30 días)', () => {
  it('menos de 30 días: chat a su asesor con nota de cliente registrado', async () => {
    const store = makeStore()
    const fetchFn = okFetch({
      ok: false,
      motivo: 'duplicado',
      asesor_id: 42,
      asesor_nombre: 'Pedro',
      fecha_registro: '01/01/2026',
      cliente_de_asesor: true,
    })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('asignada')
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(store.notas.get('conv-1')).toEqual(['Cliente ya registrado en XLR8 el 01/01/2026; se mantiene con Pedro'])
  })

  it('30 días o más: lead nuevo para su mismo asesor', async () => {
    const store = makeStore()
    const fetchFn = okFetch({
      ok: true,
      asesor_id: 42,
      asesor_nombre: 'Pedro',
      mismo_asesor: true,
      fecha_registro: '01/01/2026',
    })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('asignada')
    expect(store.notas.get('conv-1')).toEqual([
      'Derivado automáticamente a Pedro (XLR8): su cliente, último registro el 01/01/2026',
    ])
  })

  it('cupo de su asesor lleno: chat asignado ya, lead en cola sin frenar a las demás', async () => {
    const marcar = vi.fn(async () => undefined)
    const store = makeStore({ marcarEsperaAsesor: marcar })
    const fetchFn = okFetch({ ok: false, motivo: 'cupo_asesor', asesor_id: 42, asesor_nombre: 'Pedro' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO })).toBe('espera_asesor')
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(marcar).toHaveBeenCalledWith('conv-1', { tipo: 'lead', motivo: '' })
    expect(store.requeue).toHaveBeenCalledWith('conv-1', DENTRO, 'user-42')
    expect(store.notas.get('conv-1')).toEqual([
      'En espera: cliente de Pedro; el lead de XLR8 se registra cuando libere un cupo',
    ])
  })

  it('la cola sigue con las demás cuando una espera a su asesor', async () => {
    const store = makeStore()
    store.loadConversation = vi.fn(async (id: string) => ({
      account_id: 'acc-1',
      channel: 'whatsapp',
      contact_id: 'ct-1',
      assigned_agent_id: id === 'conv-a' ? 'user-42' : null,
      status: 'pending',
    }))
    store.claim = vi.fn(async () => true)
    await store.requeue('conv-a', lima('2026-11-02T08:00'), 'user-42')
    await store.requeue('conv-b', lima('2026-11-02T08:30'), null)
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).conversation_id
      const body =
        id === 'conv-a'
          ? { ok: false, motivo: 'cupo_asesor', asesor_id: 42, asesor_nombre: 'Pedro' }
          : { ok: true, asesor_id: 42, asesor_nombre: 'Luis' }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const r = await procesarColaDerivacion({ store, env: ENV, fetchFn, now: DENTRO })
    expect(r).toEqual({ derivadas: 1, descartadas: 0, enEspera: 1 })
    expect(await store.colaIds()).toEqual(['conv-a'])
  })

  it('las notas nuevas se conservan en un traspaso posterior', () => {
    const anterior = 'Cliente ya registrado en XLR8 el 01/01/2026; se mantiene con Pedro'
    expect(conservarNotasDerivacion(anterior, 'Resumen nuevo')).toBe(`Resumen nuevo\n${anterior}`)
  })
})

describe('extranjero que confirma que es para Perú', () => {
  const EXT = '+39 333 886 6681'
  const conv = (over: Record<string, unknown> = {}) =>
    vi.fn(async () => ({
      account_id: 'acc-1',
      channel: 'whatsapp',
      contact_id: 'ct-1',
      assigned_agent_id: null,
      status: 'open',
      ...over,
    }))
  const lead: Clasificacion = { tipo: 'lead', motivo: '' }

  it('sin asesor y sin confirmar: no deriva', async () => {
    const store = makeStore({ loadConversation: conv() }, EXT)
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    const verificarPeru = vi.fn(async () => false)
    expect(await derivarExtranjeroSiParaPeru('conv-1', { store, env: ENV, fetchFn, now: DENTRO, numerosPrueba: [], verificarPeru })).toBe(
      'sin_confirmar',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sin asesor y confirma Perú: deriva ya como lead a un asesor', async () => {
    const store = makeStore({ loadConversation: conv() }, EXT)
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Rosa' })
    const clasificar = vi.fn(async () => lead)
    const verificarPeru = vi.fn(async () => true)
    expect(
      await derivarExtranjeroSiParaPeru('conv-1', { store, env: ENV, fetchFn, now: DENTRO, numerosPrueba: [], verificarPeru, clasificar }),
    ).toBe('asignada')
    expect(store.saveClasificacion).toHaveBeenCalledWith('conv-1', lead)
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', NOTA_EXTRANJERO_PERU)
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.destino).toBe('ASESOR')
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
  })

  it('número peruano o con asesor: no aplica y no llama a la IA', async () => {
    const verificarPeru = vi.fn(async () => true)
    const peruano = makeStore({ loadConversation: conv() })
    expect(await derivarExtranjeroSiParaPeru('conv-1', { store: peruano, env: ENV, now: DENTRO, numerosPrueba: [], verificarPeru })).toBe(
      'no_aplica',
    )
    const conAsesor = makeStore({ loadConversation: conv({ assigned_agent_id: 'user-7' }) }, EXT)
    expect(await derivarExtranjeroSiParaPeru('conv-1', { store: conAsesor, env: ENV, now: DENTRO, numerosPrueba: [], verificarPeru })).toBe(
      'no_aplica',
    )
    const yaLead = makeStore({ loadConversation: conv({ derivacion_clasificacion: lead }) }, EXT)
    expect(await derivarExtranjeroSiParaPeru('conv-1', { store: yaLead, env: ENV, now: DENTRO, numerosPrueba: [], verificarPeru })).toBe(
      'no_aplica',
    )
    expect(verificarPeru).not.toHaveBeenCalled()
  })

  it('enviado a ATC por extranjero y luego confirma Perú: se reabre y pasa a un asesor', async () => {
    const marca = { tipo: 'atc', motivo: 'extranjero', atc_user: 'user-atc' }
    const reabrirAtcExtranjero = vi.fn(async () => true)
    const store = makeStore(
      {
        loadConversation: conv({ assigned_agent_id: 'user-atc', derivado_auto_at: '2026-11-24T10:00:00Z', derivacion_clasificacion: marca }),
        reabrirAtcExtranjero,
      },
      EXT,
    )
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Rosa' })
    const verificarPeru = vi.fn(async () => true)
    // Tras reabrir, la conversación guardada ya es lead: no se reclasifica.
    store.loadConversation = vi
      .fn()
      .mockResolvedValueOnce({ account_id: 'acc-1', channel: 'whatsapp', contact_id: 'ct-1', assigned_agent_id: 'user-atc', status: 'open', derivado_auto_at: '2026-11-24T10:00:00Z', derivacion_clasificacion: marca })
      .mockResolvedValue({ account_id: 'acc-1', channel: 'whatsapp', contact_id: 'ct-1', assigned_agent_id: 'user-atc', status: 'open', derivacion_clasificacion: lead })
    expect(await derivarExtranjeroSiParaPeru('conv-1', { store, env: ENV, fetchFn, now: DENTRO, numerosPrueba: [], verificarPeru })).toBe(
      'asignada',
    )
    expect(reabrirAtcExtranjero).toHaveBeenCalledWith('conv-1', 'user-atc')
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.destino).toBe('ASESOR')
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
  })

  it('en ATC pero ya reasignado a mano, o enviado a ATC por otro motivo: no aplica', async () => {
    const verificarPeru = vi.fn(async () => true)
    const marca = { tipo: 'atc', motivo: 'extranjero', atc_user: 'user-atc' }
    const reasignado = makeStore(
      { loadConversation: conv({ assigned_agent_id: 'user-7', derivado_auto_at: 'x', derivacion_clasificacion: marca }) },
      EXT,
    )
    expect(await derivarExtranjeroSiParaPeru('conv-1', { store: reasignado, env: ENV, now: DENTRO, numerosPrueba: [], verificarPeru })).toBe(
      'no_aplica',
    )
    const spam = makeStore(
      { loadConversation: conv({ assigned_agent_id: 'user-atc', derivado_auto_at: 'x', derivacion_clasificacion: { tipo: 'atc', motivo: 'spam' } }) },
      EXT,
    )
    expect(await derivarExtranjeroSiParaPeru('conv-1', { store: spam, env: ENV, now: DENTRO, numerosPrueba: [], verificarPeru })).toBe(
      'no_aplica',
    )
    expect(verificarPeru).not.toHaveBeenCalled()
  })

  it('al enviarlo a ATC por extranjero guarda el usuario ATC', async () => {
    const marcarAtcExtranjero = vi.fn(async () => undefined)
    const store = makeStore({ marcarAtcExtranjero }, EXT)
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'ATC' })
    const clasificar = vi.fn(async (): Promise<Clasificacion> => ({ tipo: 'atc', motivo: 'extranjero' }))
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn, now: DENTRO, numerosPrueba: [], clasificar })).toBe('asignada')
    expect(marcarAtcExtranjero).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(atcExtranjeroDe({ tipo: 'atc', motivo: 'extranjero', atc_user: 'user-42' })).toBe('user-42')
    expect(atcExtranjeroDe({ tipo: 'atc', motivo: 'extranjero' })).toBeNull()
  })
})
