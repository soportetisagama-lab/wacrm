import type { AccountRole } from '@/lib/auth/roles'

// ============================================================
// Asesores disponibles para la derivación automática XLR8.
//
// Indicador junto a la píldora del número de la línea (barra superior):
// cuántos asesores podrían recibir ahora un lead derivado por el bot y,
// al tocarlo, la fila en el orden en que el PHP los reparte (el primero
// recibe el próximo chat). Lo calcula el PHP
// de solo lectura `asesores_disponibles.php` (servidor XLR8), con la
// misma condición que `derivar_auto.php`. Solo lo ven Administrador
// (owner / admin) y ATC: la ruta /api/xlr8/asesores-disponibles
// rechaza a cualquier otro rol.
//
// URL: ASESORES_DISPONIBLES_URL si está; si no, la de DERIVAR_AUTO_URL
// con el archivo cambiado a asesores_disponibles.php. Sin URL, secreto
// (DERIVAR_AUTO_SECRET) o línea (XLR8_LINEA) el indicador no se muestra.
// ============================================================

/** Roles que ven el indicador: Administrador (owner / admin) y ATC. */
export const ROLES_ASESORES_DISPONIBLES: readonly AccountRole[] = ['owner', 'admin', 'atc']

export function puedeVerAsesoresDisponibles(role: AccountRole | null | undefined): boolean {
  return role != null && ROLES_ASESORES_DISPONIBLES.includes(role)
}

export const ARCHIVO_PHP = 'asesores_disponibles.php'

/** Caché de una respuesta correcta del PHP. */
export const CACHE_OK_MS = 45_000
/** Caché de un fallo, para no insistir al PHP en cada apertura de chat. */
export const CACHE_ERROR_MS = 15_000
/** Tiempo máximo de la llamada al PHP. */
export const TIMEOUT_MS = 5_000

const LOG = '[asesores-disponibles]'
const USER_AGENT = 'wacrm/1.0'

export interface AsesorDisponible {
  id: number
  nombre: string
}

export type ResultadoAsesores =
  | { estado: 'ok'; asesores: AsesorDisponible[] }
  | { estado: 'no_configurado' }
  | { estado: 'error' }

export interface AsesoresEnv {
  url?: string
  derivarUrl?: string
  secret?: string
  linea?: string
}

export function asesoresEnv(): AsesoresEnv {
  return {
    url: process.env.ASESORES_DISPONIBLES_URL,
    derivarUrl: process.env.DERIVAR_AUTO_URL,
    secret: process.env.DERIVAR_AUTO_SECRET,
    linea: process.env.XLR8_LINEA,
  }
}

/**
 * URL del PHP: la explícita, o la de derivar_auto.php con el último
 * segmento de la ruta cambiado a asesores_disponibles.php. null si no
 * hay ninguna válida.
 */
export function urlAsesoresDisponibles(env: AsesoresEnv): string | null {
  const explicita = env.url?.trim()
  if (explicita) return explicita
  const derivar = env.derivarUrl?.trim()
  if (!derivar) return null
  try {
    const u = new URL(derivar)
    u.pathname = u.pathname.replace(/[^/]*$/, ARCHIVO_PHP)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

/** Contador de la barra superior: "Sin asesor", "1 asesor", "3 asesores". */
export function textoContadorAsesores(cantidad: number): string {
  if (cantidad <= 0) return 'Sin asesor'
  return cantidad === 1 ? '1 asesor' : `${cantidad} asesores`
}

/** Valida la respuesta del PHP; null si no tiene la forma esperada. */
export function parsearRespuesta(body: unknown): AsesorDisponible[] | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { ok?: unknown; asesores?: unknown }
  if (b.ok !== true || !Array.isArray(b.asesores)) return null
  const lista: AsesorDisponible[] = []
  for (const item of b.asesores) {
    if (!item || typeof item !== 'object') continue
    const { id, nombre } = item as { id?: unknown; nombre?: unknown }
    const idNum = typeof id === 'number' ? id : Number(id)
    if (!Number.isFinite(idNum)) continue
    // Solo id y nombre: cualquier otro campo que mande el PHP se descarta.
    lista.push({ id: idNum, nombre: typeof nombre === 'string' ? nombre.trim() : '' })
  }
  return lista
}

interface EntradaCache {
  hasta: number
  resultado: ResultadoAsesores
}

const cache = new Map<string, EntradaCache>()
const enVuelo = new Map<string, Promise<ResultadoAsesores>>()

/** Solo para pruebas. */
export function limpiarCacheAsesores(): void {
  cache.clear()
  enVuelo.clear()
}

export interface AsesoresDeps {
  env?: AsesoresEnv
  fetchFn?: typeof fetch
  now?: () => number
}

async function llamarPhp(url: string, secret: string, linea: string, fetchFn: typeof fetch): Promise<ResultadoAsesores> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      // Mod_Security del hosting rechaza (406) un POST sin Content-Type
      // JSON o sin User-Agent propio (igual que derivar_auto.php).
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Derivar-Secret': secret,
      },
      body: JSON.stringify({ linea }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error(LOG, `PHP respondió HTTP ${res.status}`)
      return { estado: 'error' }
    }
    const asesores = parsearRespuesta(await res.json().catch(() => null))
    if (!asesores) {
      console.error(LOG, 'respuesta del PHP con formato inesperado')
      return { estado: 'error' }
    }
    return { estado: 'ok', asesores }
  } catch (err) {
    console.error(LOG, 'falló la llamada al PHP:', err instanceof Error ? err.message : err)
    return { estado: 'error' }
  }
}

/**
 * Asesores disponibles de la línea configurada, con caché corta en
 * memoria (CACHE_OK_MS / CACHE_ERROR_MS) y llamadas simultáneas
 * agrupadas en una sola. Nunca lanza.
 */
export async function consultarAsesoresDisponibles(deps: AsesoresDeps = {}): Promise<ResultadoAsesores> {
  const env = deps.env ?? asesoresEnv()
  const url = urlAsesoresDisponibles(env)
  const secret = env.secret?.trim()
  const linea = env.linea?.trim()
  if (!url || !secret || !linea) return { estado: 'no_configurado' }

  const now = deps.now ?? Date.now
  const clave = `${url}|${linea}`
  const guardado = cache.get(clave)
  if (guardado && guardado.hasta > now()) return guardado.resultado

  const pendiente = enVuelo.get(clave)
  if (pendiente) return pendiente

  const promesa = llamarPhp(url, secret, linea, deps.fetchFn ?? fetch)
    .then((resultado) => {
      cache.set(clave, {
        hasta: now() + (resultado.estado === 'ok' ? CACHE_OK_MS : CACHE_ERROR_MS),
        resultado,
      })
      return resultado
    })
    .finally(() => {
      enVuelo.delete(clave)
    })
  enVuelo.set(clave, promesa)
  return promesa
}
