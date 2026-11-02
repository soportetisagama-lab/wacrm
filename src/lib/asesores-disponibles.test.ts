import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CACHE_ERROR_MS,
  CACHE_OK_MS,
  consultarAsesoresDisponibles,
  limpiarCacheAsesores,
  parsearRespuesta,
  puedeVerAsesoresDisponibles,
  textoContadorAsesores,
  urlAsesoresDisponibles,
} from './asesores-disponibles'
import { ACCOUNT_ROLES } from './auth/roles'

const ENV = {
  derivarUrl: 'https://xlr8.test/carpeta/derivar_auto.php',
  secret: 's3cr3t',
  linea: 'LINEA_TEST',
}

function respuesta(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  limpiarCacheAsesores()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('puedeVerAsesoresDisponibles', () => {
  it('solo Administrador (owner / admin) y ATC', () => {
    const permitidos = ACCOUNT_ROLES.filter((r) => puedeVerAsesoresDisponibles(r))
    expect([...permitidos].sort()).toEqual(['admin', 'atc', 'owner'])
  })

  it('sin rol no ve nada', () => {
    expect(puedeVerAsesoresDisponibles(null)).toBe(false)
    expect(puedeVerAsesoresDisponibles(undefined)).toBe(false)
  })
})

describe('urlAsesoresDisponibles', () => {
  it('deriva la URL de DERIVAR_AUTO_URL cambiando el archivo', () => {
    expect(urlAsesoresDisponibles(ENV)).toBe('https://xlr8.test/carpeta/asesores_disponibles.php')
  })

  it('quita la query de la URL derivada', () => {
    expect(urlAsesoresDisponibles({ derivarUrl: 'https://xlr8.test/derivar_auto.php?x=1' })).toBe(
      'https://xlr8.test/asesores_disponibles.php'
    )
  })

  it('usa la variable explícita si existe', () => {
    expect(urlAsesoresDisponibles({ ...ENV, url: 'https://otra.test/a.php' })).toBe('https://otra.test/a.php')
  })

  it('null sin URL o con URL inválida', () => {
    expect(urlAsesoresDisponibles({})).toBeNull()
    expect(urlAsesoresDisponibles({ derivarUrl: 'no es url' })).toBeNull()
  })
})

describe('textoContadorAsesores', () => {
  it('sin asesores', () => {
    expect(textoContadorAsesores(0)).toBe('Sin asesor')
  })

  it('uno y varios', () => {
    expect(textoContadorAsesores(1)).toBe('1 asesor')
    expect(textoContadorAsesores(3)).toBe('3 asesores')
  })
})

describe('parsearRespuesta', () => {
  it('se queda solo con id y nombre', () => {
    expect(parsearRespuesta({ ok: true, asesores: [{ id: '7', nombre: ' Ana ', celular: '999' }] })).toEqual([
      { id: 7, nombre: 'Ana' },
    ])
  })

  it('null si el PHP no responde ok', () => {
    expect(parsearRespuesta({ ok: false, motivo: 'no_autorizado' })).toBeNull()
    expect(parsearRespuesta(null)).toBeNull()
  })
})

describe('consultarAsesoresDisponibles', () => {
  it('no_configurado sin secreto, URL o línea (no llama al PHP)', async () => {
    const fetchFn = vi.fn()
    for (const env of [{ ...ENV, secret: '' }, { ...ENV, derivarUrl: undefined }, { ...ENV, linea: ' ' }]) {
      expect(await consultarAsesoresDisponibles({ env, fetchFn })).toEqual({ estado: 'no_configurado' })
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('llama al PHP con secreto y línea, y devuelve la lista', async () => {
    const fetchFn = vi.fn(async () => respuesta({ ok: true, asesores: [{ id: 3, nombre: 'Juan' }] }))
    const r = await consultarAsesoresDisponibles({ env: ENV, fetchFn })
    expect(r).toEqual({ estado: 'ok', asesores: [{ id: 3, nombre: 'Juan' }] })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://xlr8.test/carpeta/asesores_disponibles.php')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Derivar-Secret']).toBe('s3cr3t')
    expect(JSON.parse(init.body as string)).toEqual({ linea: 'LINEA_TEST' })
  })

  it('error si el PHP falla, responde HTTP de error o lanza', async () => {
    const casos = [
      vi.fn(async () => respuesta({ ok: false, motivo: 'error_bd' }, 500)),
      vi.fn(async () => respuesta({ ok: false })),
      vi.fn(async () => {
        throw new Error('timeout')
      }),
    ]
    for (const fetchFn of casos) {
      limpiarCacheAsesores()
      expect(await consultarAsesoresDisponibles({ env: ENV, fetchFn })).toEqual({ estado: 'error' })
    }
  })

  it('cachea la respuesta correcta CACHE_OK_MS', async () => {
    let t = 1_000
    const now = () => t
    const fetchFn = vi.fn(async () => respuesta({ ok: true, asesores: [] }))
    await consultarAsesoresDisponibles({ env: ENV, fetchFn, now })
    t += CACHE_OK_MS - 1
    await consultarAsesoresDisponibles({ env: ENV, fetchFn, now })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    t += 2
    await consultarAsesoresDisponibles({ env: ENV, fetchFn, now })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('cachea el fallo menos tiempo (CACHE_ERROR_MS)', async () => {
    let t = 1_000
    const now = () => t
    const fetchFn = vi.fn(async () => respuesta({}, 502))
    await consultarAsesoresDisponibles({ env: ENV, fetchFn, now })
    t += CACHE_ERROR_MS + 1
    await consultarAsesoresDisponibles({ env: ENV, fetchFn, now })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('agrupa llamadas simultáneas en una sola', async () => {
    const fetchFn = vi.fn(async () => respuesta({ ok: true, asesores: [] }))
    await Promise.all([
      consultarAsesoresDisponibles({ env: ENV, fetchFn }),
      consultarAsesoresDisponibles({ env: ENV, fetchFn }),
    ])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
