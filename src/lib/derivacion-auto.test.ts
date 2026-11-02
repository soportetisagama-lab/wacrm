import { describe, it, expect, vi } from 'vitest'
import {
  NUMEROS_PRUEBA,
  celularNueveDigitos,
  debeDerivarCelular,
  derivarAuto,
  type DerivacionStore,
} from './derivacion-auto'

const ENV = { url: 'https://xlr8.test/derivar.php', secret: 's3cr3t', linea: 'INOX' }

function makeStore(over: Partial<DerivacionStore> = {}, phone = '+51 926 843 129') {
  let claimed = false
  const store: DerivacionStore = {
    loadConversation: vi.fn(async () => ({ account_id: 'acc-1', channel: 'whatsapp', contact_id: 'ct-1' })),
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
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('no_es_prueba')
    expect(store.claim).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('no deriva canales que no son WhatsApp', async () => {
    const store = makeStore({
      loadConversation: vi.fn(async () => ({ account_id: 'acc-1', channel: 'instagram', contact_id: 'ct-1' })),
    })
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('no_whatsapp')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('sin variables de entorno', () => {
  it('no hace nada si falta la URL o el secreto', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42 })
    expect(await derivarAuto('conv-1', { store, env: { secret: 'x' }, fetchFn })).toBe('sin_env')
    expect(await derivarAuto('conv-1', { store, env: { url: 'https://x', secret: ' ' }, fetchFn })).toBe('sin_env')
    expect(store.loadConversation).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('idempotencia', () => {
  it('llama al PHP una sola vez por conversación', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('asignada')
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('ya_derivada')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('si el PHP falla no reintenta', async () => {
    const store = makeStore()
    const fetchFn = vi.fn(async (): Promise<Response> => {
      throw new Error('timeout')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('error_php')
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('ya_derivada')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(store.assign).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('llamada y mapeo de asesor', () => {
  it('envía el payload y asigna al perfil con ese xlr8_user_id', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: true, asesor_id: '42', asesor_nombre: 'Luis Pérez' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('asignada')

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ENV.url)
    const headers = init.headers as Record<string, string>
    expect(headers['X-Derivar-Secret']).toBe('s3cr3t')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['User-Agent']).toBe('wacrm-inox/1.0')
    expect(JSON.parse(init.body as string)).toEqual({
      linea: 'INOX',
      celular: '926843129',
      nombre: 'Ana',
      codigo_anuncio: '120210000000001',
      conversation_id: 'conv-1',
    })
    expect(store.findAgentByXlr8).toHaveBeenCalledWith('acc-1', 42)
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', 'Derivado automáticamente a Luis Pérez (XLR8)')
  })

  it('sin perfil con ese ID deja la conversación sin asignar', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchFn = okFetch({ ok: true, asesor_id: 7, asesor_nombre: 'Rosa' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('sin_usuario')
    expect(store.assign).not.toHaveBeenCalled()
    expect(store.appendNote).toHaveBeenCalledWith('conv-1', expect.stringContaining('queda sin asignar'))
    err.mockRestore()
  })

  it('duplicado con asesor_id asigna igual', async () => {
    const store = makeStore()
    const fetchFn = okFetch({ ok: false, motivo: 'duplicado', asesor_id: 42, asesor_nombre: 'Luis' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('asignada')
    expect(store.assign).toHaveBeenCalledWith('conv-1', 'user-42')
  })

  it('ok:false del PHP no asigna', async () => {
    const store = makeStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchFn = okFetch({ ok: false, motivo: 'sin_asesor' })
    expect(await derivarAuto('conv-1', { store, env: ENV, fetchFn })).toBe('rechazada')
    expect(store.findAgentByXlr8).not.toHaveBeenCalled()
    expect(store.assign).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
