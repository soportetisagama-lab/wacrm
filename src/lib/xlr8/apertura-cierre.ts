import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Apertura y cierre diario en XLR8 (apertura_cierre.php).
//
//   - Apertura: de lunes a sábado a las 07:55 (Lima) envía la cantidad de
//     chats de WhatsApp sin derivar: abiertos o en espera, con mensajes
//     del cliente sin leer y sin asesor asignado (la misma definición de
//     /api/leads/pending). Industrial no envía apertura.
//   - Cierre: de lunes a viernes a las 17:30 y el sábado a las 13:00
//     avisa al PHP para que guarde la copia del flotante de la línea.
//     Feriados incluidos.
//
// Va montado en el cron de flujos (cada minuto). Dentro de cada ventana
// reintenta cada minuto hasta que el PHP responde ok; el PHP es
// idempotente (la apertura se actualiza; un cierre repetido no pisa la
// primera copia).
//
// Variables: usa DERIVAR_AUTO_URL (cambiando el archivo por
// apertura_cierre_api.php) y DERIVAR_AUTO_SECRET, así no hay que crear
// variables nuevas. XLR8_APERTURA_URL / XLR8_APERTURA_SECRET, si existen,
// tienen prioridad. XLR8_LINEA dice la línea.
// ============================================================

const LOG = '[apertura-cierre]'
const ARCHIVO_PHP = 'apertura_cierre_api.php'
const TIMEOUT_MS = 20_000

export type TareaApertura = 'apertura' | 'cierre'

/** Ventanas en hora de Lima, [inicio, fin) en "HH:MM", por día (0 = domingo). */
const VENTANAS: Record<TareaApertura, Record<number, [string, string] | null>> = {
  apertura: { 0: null, 1: ['07:55', '08:00'], 2: ['07:55', '08:00'], 3: ['07:55', '08:00'], 4: ['07:55', '08:00'], 5: ['07:55', '08:00'], 6: ['07:55', '08:00'] },
  cierre: { 0: null, 1: ['17:30', '17:45'], 2: ['17:30', '17:45'], 3: ['17:30', '17:45'], 4: ['17:30', '17:45'], 5: ['17:30', '17:45'], 6: ['13:00', '13:15'] },
}

const LIMA_OFFSET_MS = -5 * 60 * 60_000 // Perú no tiene horario de verano

function limaParts(now: Date): { fecha: string; dia: number; minuto: number } {
  const d = new Date(now.getTime() + LIMA_OFFSET_MS)
  return { fecha: d.toISOString().slice(0, 10), dia: d.getUTCDay(), minuto: d.getUTCHours() * 60 + d.getUTCMinutes() }
}

function minutosDe(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export interface EnvApertura {
  url: string | null
  secret: string | null
  linea: string | null
}

export function envApertura(env: Record<string, string | undefined> = process.env): EnvApertura {
  const propia = env.XLR8_APERTURA_URL?.trim()
  const derivar = env.DERIVAR_AUTO_URL?.trim()
  const url = propia || (derivar ? derivar.replace(/[^/]*$/, ARCHIVO_PHP) : '')
  const secret = env.XLR8_APERTURA_SECRET?.trim() || env.DERIVAR_AUTO_SECRET?.trim() || ''
  const linea = env.XLR8_LINEA?.trim() || ''
  return { url: url || null, secret: secret || null, linea: linea || null }
}

/** Industrial todavía no tiene XLR9 en la apertura (solo cierre). */
export function lineaEnviaApertura(linea: string): boolean {
  return linea.trim().toUpperCase() !== 'INDUSTRIAL'
}

/**
 * Pura: tareas que tocan ahora y aún no se hicieron hoy.
 * `hechas` guarda la fecha (Lima) en que cada tarea quedó ok.
 */
export function tareasPendientes(
  now: Date,
  hechas: Partial<Record<TareaApertura, string>>,
  linea: string,
): { fecha: string; tareas: TareaApertura[] } {
  const { fecha, dia, minuto } = limaParts(now)
  const tareas: TareaApertura[] = []
  for (const tarea of ['apertura', 'cierre'] as const) {
    if (tarea === 'apertura' && !lineaEnviaApertura(linea)) continue
    const v = VENTANAS[tarea][dia]
    if (!v || minuto < minutosDe(v[0]) || minuto >= minutosDe(v[1])) continue
    if (hechas[tarea] === fecha) continue
    tareas.push(tarea)
  }
  return { fecha, tareas }
}

export interface AperturaDeps {
  env: EnvApertura
  contarSinDerivar: () => Promise<number>
  fetchImpl?: typeof fetch
}

/** Envía una tarea al PHP. True si quedó hecha (ok del PHP). Nunca lanza. */
export async function enviarTarea(tarea: TareaApertura, fecha: string, deps: AperturaDeps): Promise<boolean> {
  const { url, secret, linea } = deps.env
  if (!url || !secret || !linea) return false
  try {
    const body: Record<string, unknown> = { accion: tarea, linea, fecha }
    if (tarea === 'apertura') body.cantidad = await deps.contarSinDerivar()
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Apertura-Secret': secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean; motivo?: string } | null
    if (res.ok && data?.ok) {
      console.log(`${LOG} ${tarea} ${fecha} ok`, data.motivo ?? '')
      return true
    }
    console.error(`${LOG} ${tarea} ${fecha} respondió ${res.status}`, data?.motivo ?? '')
    return false
  } catch (err) {
    console.error(`${LOG} ${tarea} ${fecha} falló:`, err instanceof Error ? err.message : err)
    return false
  }
}

/** Chats de WhatsApp sin derivar (definición de /api/leads/pending). */
export async function contarSinDerivar(db: SupabaseClient): Promise<number> {
  let q = db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'whatsapp')
    .in('status', ['open', 'pending'])
    .gt('unread_count', 0)
    .is('assigned_agent_id', null)
  const accountId = process.env.LEADS_PENDING_ACCOUNT_ID?.trim()
  if (accountId) q = q.eq('account_id', accountId)
  const { count, error } = await q
  if (error) throw new Error(error.message)
  return count ?? 0
}

interface EstadoApertura {
  corriendo: boolean
  hechas: Partial<Record<TareaApertura, string>>
}
const g = globalThis as { __wacrmAperturaCierre?: EstadoApertura }
function estado(): EstadoApertura {
  g.__wacrmAperturaCierre ??= { corriendo: false, hechas: {} }
  return g.__wacrmAperturaCierre
}

/** Entrada del cron de flujos. Barata fuera de las ventanas; nunca lanza. */
export async function runAperturaCierreSiToca(db: SupabaseClient, now: Date = new Date()): Promise<void> {
  const s = estado()
  if (s.corriendo) return
  const env = envApertura()
  if (!env.url || !env.secret || !env.linea) return
  const { fecha, tareas } = tareasPendientes(now, s.hechas, env.linea)
  if (!tareas.length) return
  s.corriendo = true
  try {
    for (const tarea of tareas) {
      if (await enviarTarea(tarea, fecha, { env, contarSinDerivar: () => contarSinDerivar(db) })) {
        s.hechas[tarea] = fecha
      }
    }
  } finally {
    s.corriendo = false
  }
}
