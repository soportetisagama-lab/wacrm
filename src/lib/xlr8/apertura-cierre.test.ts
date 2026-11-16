import { describe, it, expect, vi } from 'vitest'
import { envApertura, enviarTarea, tareasPendientes } from './apertura-cierre'

/** Hora de Lima (UTC-5). 2026-11-16 es lunes; 2026-11-21 sábado; 2026-11-22 domingo. */
function lima(isoLocal: string): Date {
  return new Date(`${isoLocal}:00-05:00`)
}

describe('tareasPendientes', () => {
  it('apertura de lunes a sábado entre 07:55 y 07:59', () => {
    expect(tareasPendientes(lima('2026-11-16T07:54'), {}, 'INOX').tareas).toEqual([])
    expect(tareasPendientes(lima('2026-11-16T07:55'), {}, 'INOX')).toEqual({ fecha: '2026-11-16', tareas: ['apertura'] })
    expect(tareasPendientes(lima('2026-11-21T07:59'), {}, 'MAXI').tareas).toEqual(['apertura'])
    expect(tareasPendientes(lima('2026-11-16T08:00'), {}, 'INOX').tareas).toEqual([])
    expect(tareasPendientes(lima('2026-11-22T07:56'), {}, 'INOX').tareas).toEqual([])
  })

  it('cierre a las 17:30 de lunes a viernes y 13:00 el sábado', () => {
    expect(tareasPendientes(lima('2026-11-20T17:29'), {}, 'RETAIL').tareas).toEqual([])
    expect(tareasPendientes(lima('2026-11-20T17:30'), {}, 'RETAIL').tareas).toEqual(['cierre'])
    expect(tareasPendientes(lima('2026-11-21T17:30'), {}, 'RETAIL').tareas).toEqual([])
    expect(tareasPendientes(lima('2026-11-21T13:00'), {}, 'RETAIL').tareas).toEqual(['cierre'])
    expect(tareasPendientes(lima('2026-11-22T13:00'), {}, 'RETAIL').tareas).toEqual([])
  })

  it('no repite una tarea ya hecha ese día', () => {
    expect(tareasPendientes(lima('2026-11-16T17:31'), { cierre: '2026-11-16' }, 'INOX').tareas).toEqual([])
    expect(tareasPendientes(lima('2026-11-17T17:31'), { cierre: '2026-11-16' }, 'INOX').tareas).toEqual(['cierre'])
  })

  it('Industrial no envía apertura, pero sí cierre', () => {
    expect(tareasPendientes(lima('2026-11-16T07:56'), {}, 'INDUSTRIAL').tareas).toEqual([])
    expect(tareasPendientes(lima('2026-11-16T17:30'), {}, 'INDUSTRIAL').tareas).toEqual(['cierre'])
  })
})

describe('envApertura', () => {
  it('toma la URL de DERIVAR_AUTO_URL cambiando el archivo', () => {
    const env = envApertura({ DERIVAR_AUTO_URL: 'https://xlr8.test/crm/derivar_auto.php', DERIVAR_AUTO_SECRET: 's', XLR8_LINEA: 'INOX' })
    expect(env).toEqual({ url: 'https://xlr8.test/crm/apertura_cierre_api.php', secret: 's', linea: 'INOX' })
  })
  it('las variables propias tienen prioridad', () => {
    const env = envApertura({
      DERIVAR_AUTO_URL: 'https://xlr8.test/derivar_auto.php',
      DERIVAR_AUTO_SECRET: 's',
      XLR8_APERTURA_URL: 'https://otro.test/a.php',
      XLR8_APERTURA_SECRET: 'k',
      XLR8_LINEA: 'MAXI',
    })
    expect(env).toEqual({ url: 'https://otro.test/a.php', secret: 'k', linea: 'MAXI' })
  })
})

describe('enviarTarea', () => {
  const env = { url: 'https://xlr8.test/apertura_cierre_api.php', secret: 's3cr3t', linea: 'INOX' }

  it('envía la apertura con la cantidad y el header secreto', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, guardado: true }), { status: 200 }))
    const ok = await enviarTarea('apertura', '2026-11-16', { env, contarSinDerivar: async () => 7, fetchImpl })
    expect(ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(env.url)
    expect((init.headers as Record<string, string>)['X-Apertura-Secret']).toBe('s3cr3t')
    expect(JSON.parse(init.body as string)).toEqual({ accion: 'apertura', linea: 'INOX', fecha: '2026-11-16', cantidad: 7 })
  })

  it('el cierre no cuenta chats', async () => {
    const contar = vi.fn(async () => 3)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, guardado: false, motivo: 'ya_existe' }), { status: 200 }))
    expect(await enviarTarea('cierre', '2026-11-16', { env, contarSinDerivar: contar, fetchImpl })).toBe(true)
    expect(contar).not.toHaveBeenCalled()
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ accion: 'cierre', linea: 'INOX', fecha: '2026-11-16' })
  })

  it('falla (y se reintenta) si el PHP no responde ok', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, motivo: 'no_autorizado' }), { status: 401 }))
    expect(await enviarTarea('cierre', '2026-11-16', { env, contarSinDerivar: async () => 0, fetchImpl })).toBe(false)
    const caido = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    expect(await enviarTarea('apertura', '2026-11-16', { env, contarSinDerivar: async () => 0, fetchImpl: caido as unknown as typeof fetch })).toBe(false)
    err.mockRestore()
  })

  it('sin variables no hace nada', async () => {
    const fetchImpl = vi.fn()
    expect(await enviarTarea('cierre', '2026-11-16', { env: { url: null, secret: 's', linea: 'INOX' }, contarSinDerivar: async () => 0, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
