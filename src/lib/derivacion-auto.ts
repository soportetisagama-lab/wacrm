import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { canAssignAgentToConversation } from '@/lib/conversations/assignee-guard'
import {
  CLASIFICACION_LEAD,
  MOTIVO_ATC_TEXTO,
  clasificadorOpenAi,
  type Clasificacion,
  type ClasificadorDerivacion,
} from '@/lib/derivacion-clasificar'

// ============================================================
// Derivación automática de leads de WhatsApp al sistema PHP XLR8.
//
// Se dispara en el traspaso a un asesor ("un asesor se contactará
// contigo"): los dos caminos que existen terminan aquí —
//   - flujos: markConversationPendingHandoff (lib/flows/engine.ts),
//   - IA libre: handOffToHuman (lib/ai/auto-reply.ts), también cuando
//     completa un traspaso que esperaba el número del cliente.
//
// El PHP elige al asesor y responde { ok, asesor_id, asesor_nombre };
// aquí se asigna la conversación al usuario del CRM con ese
// `profiles.xlr8_user_id` (migración 088). Una sola vez por
// conversación (`conversations.derivado_auto_at`, reclamado antes de
// llamar): si el PHP falla no se reintenta, queda para derivación
// manual como antes. Nunca lanza ni bloquea la respuesta del bot.
//
// Cupo lleno: si el PHP responde `sin_asesor` (todos los asesores con
// el cupo lleno), HTTP 503 (`ocupado`) o HTTP 429 (el hosting limita
// las peticiones; llega como página HTML, sin JSON), se deshace el
// reclamo y la conversación vuelve a la cola sin perder su turno (resultado
// 'en_espera'); la pasada de la cola se corta ahí. La clasificación se
// guarda (`derivacion_clasificacion`, migración 096) para no volver a
// llamar a la IA en cada reintento.
//
// Orden estricto: dentro de horario, si ya hay conversaciones en cola,
// un traspaso nuevo entra a la cola en vez de derivarse directo, para
// respetar el orden de llegada.
//
// Histórico (`derivacion_historica`, migración 096): conversaciones
// cargadas a mano a la cola (supabase/manual/derivacion_historica_semana.sql);
// el JSON al PHP lleva `historico: true`.
//
// Horario laboral (HORARIO_DERIVACION, hora de Lima): fuera de horario
// la conversación no se deriva todavía; queda en cola
// (`conversations.derivacion_pendiente_at`, migración 089) y el cron de
// flujos (/api/flows/cron, cada minuto) la deriva en cuanto abre el
// horario, la más antigua primero (`procesarColaDerivacion`).
//
// Clasificación (lib/derivacion-clasificar.ts): justo antes de llamar al
// PHP, la IA (solo OpenAI) decide si es un lead real (destino ASESOR) o
// un caso para ATC (trabajo, spam, proveedor, otro tema, extranjero con
// pedido fuera de Perú). Si la IA falla, va como lead.
// ============================================================

/**
 * MODO PRUEBA: solo estos celulares se derivan automáticamente.
 * Cualquier otro número no hace nada. Para abrirlo a todos los leads,
 * quitar este filtro en `debeDerivarCelular`.
 */
export const NUMEROS_PRUEBA: readonly string[] = ['51926843129', '926843129']

/** Tiempo máximo de la llamada al PHP. */
export const DERIVAR_TIMEOUT_MS = 8_000

const LOG = '[derivacion-auto]'
const USER_AGENT = 'wacrm/1.0'

/** Nota interna cuando el traspaso queda en cola fuera de horario. */
export const NOTA_EN_COLA = 'Se derivará automáticamente al abrir el horario'

/** Nota interna cuando el traspaso espera su turno detrás de la cola. */
export const NOTA_EN_TURNO = 'En cola: se derivará automáticamente por orden de llegada'

/** Nota interna (una sola vez) cuando el PHP no tiene asesor con cupo libre. */
export const NOTA_EN_ESPERA = 'En espera: todos los asesores tienen el cupo lleno'

/**
 * Las notas de la derivación (asesor de XLR8, cola, espera) viven en
 * `ai_handoff_summary`. Un traspaso posterior (flujo o IA) reescribe ese
 * resumen: esto le agrega las líneas de derivación que ya había, para
 * que el asesor no las pierda.
 */
export function conservarNotasDerivacion(anterior: string | null | undefined, nuevo: string): string {
  const notas = (anterior ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.startsWith('Derivado automáticamente') ||
        l === NOTA_EN_COLA ||
        l === NOTA_EN_TURNO ||
        l === NOTA_EN_ESPERA,
    )
    .filter((l) => !nuevo.includes(l))
  return notas.length ? [nuevo, ...notas].filter(Boolean).join('\n') : nuevo
}

/** Motivos del PHP que significan "reintentar más tarde" (cupo lleno). */
const MOTIVOS_EN_ESPERA: readonly string[] = ['sin_asesor', 'ocupado']

/** Estados en que una conversación de la cola todavía se deriva. */
const ESTADOS_DERIVABLES: readonly string[] = ['pending', 'open']

/** Conversaciones de la cola que se procesan como máximo por pasada del cron. */
export const COLA_LIMITE_POR_PASADA = 10

/** Tramo "HH:MM"–"HH:MM", inicio incluido y fin excluido. */
export type TramoHorario = readonly [desde: string, hasta: string]

export interface HorarioDerivacion {
  zonaHoraria: string
  /** Jornada por día de la semana (0 = domingo … 6 = sábado); null = no se deriva. */
  jornada: Readonly<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, TramoHorario | null>>
  /** Pausa que se excluye todos los días. */
  almuerzo: TramoHorario | null
}

/**
 * Horario en que se deriva automáticamente (hora de Lima):
 * L–J 08:00–17:00, viernes 08:00–17:30, sábado 08:00–12:30, almuerzo
 * 12:45–14:00 excluido todos los días, domingo no se deriva.
 */
export const HORARIO_DERIVACION: HorarioDerivacion = {
  zonaHoraria: 'America/Lima',
  jornada: {
    0: null,
    1: ['08:00', '17:00'],
    2: ['08:00', '17:00'],
    3: ['08:00', '17:00'],
    4: ['08:00', '17:00'],
    5: ['08:00', '17:30'],
    6: ['08:00', '12:30'],
  },
  almuerzo: ['12:45', '14:00'],
}

const DIAS: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function minutosDe(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function enTramo(min: number, tramo: TramoHorario | null): boolean {
  return tramo !== null && min >= minutosDe(tramo[0]) && min < minutosDe(tramo[1])
}

/** True si `date` cae dentro del horario de derivación (función pura). */
export function dentroDeHorario(date: Date, horario: HorarioDerivacion = HORARIO_DERIVACION): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: horario.zonaHoraria,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const dia = DIAS[get('weekday')]
  if (dia === undefined) return false
  const min = Number(get('hour')) * 60 + Number(get('minute'))
  return enTramo(min, horario.jornada[dia]) && !enTramo(min, horario.almuerzo)
}

/** True si el número no es peruano (ni 9 dígitos ni 51 + 9 dígitos). Solo contexto para la IA. */
export function esNumeroExtranjero(phone: string | null | undefined): boolean {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length > 0 && celularNueveDigitos(digits) === null
}

/** Celular peruano en 9 dígitos sin el 51, o null si no lo es. */
export function celularNueveDigitos(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 9) return digits
  if (digits.length === 11 && digits.startsWith('51')) return digits.slice(2)
  return null
}

/**
 * Celular que se envía al PHP: el peruano en 9 dígitos sin el 51; el
 * extranjero con todos sus dígitos internacionales, sin el + (9 a 15
 * dígitos; el PHP acepta 9 o más). null si tiene menos de 9 o más de 15.
 */
export function celularDerivacion(phone: string | null | undefined): string | null {
  const peruano = celularNueveDigitos(phone)
  if (peruano) return peruano
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 9 && digits.length <= 15 ? digits : null
}

/** True cuando el celular está permitido por el MODO PRUEBA. */
export function debeDerivarCelular(
  phone: string | null | undefined,
  numerosPrueba: readonly string[] = NUMEROS_PRUEBA,
): boolean {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (!digits) return false
  const nueve = celularNueveDigitos(digits)
  return numerosPrueba.includes(digits) || (nueve !== null && numerosPrueba.includes(nueve))
}

export interface DerivacionEnv {
  url?: string
  secret?: string
  linea?: string
}

export function derivacionEnv(): DerivacionEnv {
  return {
    url: process.env.DERIVAR_AUTO_URL,
    secret: process.env.DERIVAR_AUTO_SECRET,
    linea: process.env.XLR8_LINEA,
  }
}

function envListo(env: DerivacionEnv): env is DerivacionEnv & { url: string; secret: string } {
  return Boolean(env.url?.trim() && env.secret?.trim())
}

/** Línea configurada (XLR8_LINEA), o null. Nunca se asume una por defecto. */
function lineaDe(env: DerivacionEnv): string | null {
  return env.linea?.trim() || null
}

/**
 * Pura: true cuando derivarAuto intentaría derivar este número (variables
 * configuradas, línea definida, celular válido y permitido por el MODO
 * PRUEBA). Horario, cola y cupo no cuentan: esos casos igual se derivan
 * después. La usa el webhook antes de prometer la derivación.
 */
export function numeroSeDerivara(
  phone: string | null | undefined,
  env: DerivacionEnv = derivacionEnv(),
  numerosPrueba: readonly string[] = NUMEROS_PRUEBA,
): boolean {
  return (
    envListo(env) &&
    lineaDe(env) !== null &&
    celularDerivacion(phone) !== null &&
    debeDerivarCelular(phone, numerosPrueba)
  )
}

export interface ConversacionDerivacion {
  account_id: string
  channel: string | null
  contact_id: string
  assigned_agent_id?: string | null
  status?: string | null
  /** Cargada a la cola a mano (migración 096): el PHP recibe `historico: true`. */
  derivacion_historica?: boolean | null
  /** Clasificación guardada en un intento anterior (migración 096). */
  derivacion_clasificacion?: unknown
}

/** Conversación en cola con su hora de entrada (su turno). */
export interface ColaItem {
  id: string
  at: Date
}

/** Acceso a datos que usa la derivación (inyectable en los tests). */
export interface DerivacionStore {
  loadConversation(id: string): Promise<ConversacionDerivacion | null>
  loadContact(id: string): Promise<{ phone: string | null; name: string | null } | null>
  /** Marca la conversación como derivada; false si ya lo estaba (o falla). */
  claim(conversationId: string): Promise<boolean>
  /** ID del anuncio de Meta (click-to-WhatsApp) de la conversación, o ''. */
  loadAdId(conversationId: string): Promise<string>
  /** user_id del perfil con ese ID XLR8 en la cuenta, o null. */
  findAgentByXlr8(accountId: string, xlr8UserId: number): Promise<string | null>
  /** Asigna la conversación; false si no se pudo. */
  assign(conversationId: string, userId: string): Promise<boolean>
  /** Agrega una línea a la nota interna del traspaso; no la repite si ya está. */
  appendNote(conversationId: string, line: string): Promise<void>
  /** Pone la conversación en cola (fuera de horario); false si ya estaba, ya se derivó o falla. */
  enqueue(conversationId: string, at: Date, agente: string | null): Promise<boolean>
  /**
   * Cupo lleno: deshace el reclamo (`derivado_auto_at = null`) y la deja
   * en cola con la hora `at`; false si falla.
   */
  requeue(conversationId: string, at: Date, agente: string | null): Promise<boolean>
  /** True si hay otra conversación en cola todavía derivable (pending/open). */
  hasPendingQueue(excludeConversationId: string): Promise<boolean>
  /** Guarda la clasificación para reutilizarla en los reintentos. */
  saveClasificacion(conversationId: string, clasificacion: Clasificacion): Promise<void>
  /** Conversaciones en cola, la más antigua primero. */
  listQueue(limit: number): Promise<ColaItem[]>
  /**
   * Saca de la cola y devuelve el asesor que tenía al encolar; null si
   * otro proceso ya la sacó (idempotencia).
   */
  dequeue(conversationId: string): Promise<{ agente: string | null } | null>
}

export type DerivacionResultado =
  | 'sin_env'
  | 'sin_linea'
  | 'en_cola'
  | 'ya_en_cola'
  | 'en_espera'
  | 'sin_conversacion'
  | 'no_whatsapp'
  | 'sin_celular'
  | 'no_es_prueba'
  | 'ya_derivada'
  | 'error_php'
  | 'rechazada'
  | 'asignada'
  | 'sin_usuario'
  | 'con_asesor'

interface RespuestaPhp {
  ok?: unknown
  asesor_id?: unknown
  asesor_nombre?: unknown
  motivo?: unknown
}

export interface DerivacionDeps {
  store: DerivacionStore
  env?: DerivacionEnv
  fetchFn?: typeof fetch
  /** Hora actual (inyectable en los tests). */
  now?: Date
  horario?: HorarioDerivacion
  /** Clasificador lead/ATC; sin él, todo va como lead. */
  clasificar?: ClasificadorDerivacion
  /** Solo para los tests: reemplaza NUMEROS_PRUEBA. */
  numerosPrueba?: readonly string[]
}

/** Opciones internas de derivarAuto. */
export interface DerivarOpciones {
  /** Viene de la cola: hora original de entrada (su turno si vuelve a esperar). */
  desdeCola?: { at: Date }
  /**
   * Viene del webhook (cualquier mensaje entrante): no toca chats que
   * ya tienen asesor, para no reasignar conversaciones atendidas.
   */
  soloSinAsesor?: boolean
}

/** Clasificación guardada en la conversación, o null si no hay o no es válida. */
export function clasificacionGuardada(valor: unknown): Clasificacion | null {
  if (!valor || typeof valor !== 'object') return null
  const { tipo, motivo } = valor as { tipo?: unknown; motivo?: unknown }
  if (tipo === 'lead') return CLASIFICACION_LEAD
  if (tipo === 'atc' && typeof motivo === 'string' && Object.hasOwn(MOTIVO_ATC_TEXTO, motivo)) {
    return { tipo: 'atc', motivo: motivo as keyof typeof MOTIVO_ATC_TEXTO }
  }
  return null
}

/** Clasifica; `confiable` es false si no hay clasificador o falló (entonces no se guarda). */
async function clasificarSeguro(
  deps: DerivacionDeps,
  input: Parameters<ClasificadorDerivacion>[0],
): Promise<{ clasificacion: Clasificacion; confiable: boolean }> {
  if (!deps.clasificar) return { clasificacion: CLASIFICACION_LEAD, confiable: false }
  try {
    return { clasificacion: await deps.clasificar(input), confiable: true }
  } catch (err) {
    console.error(LOG, 'clasificación falló; va como lead:', err instanceof Error ? err.message : err, {
      conversationId: input.conversationId,
    })
    return { clasificacion: CLASIFICACION_LEAD, confiable: false }
  }
}

/**
 * Deriva la conversación al PHP si cumple todas las condiciones.
 * Fuera de horario la deja en cola (sin llamar al PHP).
 * Nunca lanza: cualquier error se registra y la conversación queda
 * para derivación manual.
 */
export async function derivarAuto(
  conversationId: string,
  deps: DerivacionDeps,
  opciones: DerivarOpciones = {},
): Promise<DerivacionResultado> {
  const env = deps.env ?? derivacionEnv()
  if (!envListo(env)) return 'sin_env'
  const linea = lineaDe(env)
  if (!linea) {
    console.error(LOG, 'falta XLR8_LINEA: no se deriva', { conversationId })
    return 'sin_linea'
  }
  const { store } = deps
  const now = deps.now ?? new Date()
  const fetchFn = deps.fetchFn ?? fetch
  try {
    const conv = await store.loadConversation(conversationId)
    if (!conv) return 'sin_conversacion'
    if ((conv.channel ?? 'whatsapp') !== 'whatsapp') return 'no_whatsapp'
    if (opciones.soloSinAsesor && conv.assigned_agent_id) return 'con_asesor'

    const contact = await store.loadContact(conv.contact_id)
    const celular = celularDerivacion(contact?.phone)
    if (!celular) return 'sin_celular'
    if (!debeDerivarCelular(contact?.phone, deps.numerosPrueba)) return 'no_es_prueba'

    // Fuera de horario: a la cola, sin llamar al PHP. El cron la deriva
    // al abrir el horario.
    if (!dentroDeHorario(now, deps.horario)) {
      if (!(await store.enqueue(conversationId, now, conv.assigned_agent_id ?? null))) return 'ya_en_cola'
      await store.appendNote(conversationId, NOTA_EN_COLA)
      return 'en_cola'
    }

    // Orden estricto: si ya hay conversaciones esperando en la cola, el
    // traspaso en vivo entra detrás de ellas (la cola las deriva en orden).
    if (!opciones.desdeCola && (await store.hasPendingQueue(conversationId))) {
      if (!(await store.enqueue(conversationId, now, conv.assigned_agent_id ?? null))) return 'ya_en_cola'
      await store.appendNote(conversationId, NOTA_EN_TURNO)
      return 'en_cola'
    }

    // Reclamada ANTES de llamar: una sola llamada por conversación,
    // aunque el PHP falle o dos traspasos coincidan.
    if (!(await store.claim(conversationId))) return 'ya_derivada'

    const codigoAnuncio = await store.loadAdId(conversationId).catch(() => '')
    // Reintento tras cupo lleno: reutiliza la clasificación guardada.
    let clasificacion = clasificacionGuardada(conv.derivacion_clasificacion)
    if (!clasificacion) {
      const r = await clasificarSeguro(deps, {
        accountId: conv.account_id,
        conversationId,
        numeroExtranjero: esNumeroExtranjero(contact?.phone),
      })
      clasificacion = r.clasificacion
      if (r.confiable) await store.saveClasificacion(conversationId, clasificacion).catch(() => undefined)
    }
    const motivoAtc = clasificacion.tipo === 'atc' ? MOTIVO_ATC_TEXTO[clasificacion.motivo] : ''
    let body: RespuestaPhp
    try {
      const res = await fetchFn(env.url, {
        method: 'POST',
        // Mod_Security del hosting rechaza (406) un POST sin Content-Type
        // JSON o sin User-Agent propio.
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-Derivar-Secret': env.secret,
        },
        body: JSON.stringify({
          linea,
          celular,
          nombre: contact?.name?.trim() ?? '',
          codigo_anuncio: codigoAnuncio,
          conversation_id: conversationId,
          destino: clasificacion.tipo === 'atc' ? 'ATC' : 'ASESOR',
          motivo_atc: motivoAtc,
          historico: conv.derivacion_historica === true,
        }),
        signal: AbortSignal.timeout(DERIVAR_TIMEOUT_MS),
        cache: 'no-store',
      })
      body = ((await res.json().catch(() => null)) ?? {}) as RespuestaPhp
      // 503 = PHP ocupado (cupo lleno) y 429 = el hosting limita las
      // peticiones (página HTML): ambos esperan en la cola, con o sin JSON.
      if (res.status === 503 || res.status === 429) body = { ...body, ok: false, motivo: 'ocupado' }
      if (!res.ok && body.ok !== false) {
        console.error(LOG, `PHP respondió HTTP ${res.status}`, { conversationId })
        return 'error_php'
      }
    } catch (err) {
      console.error(LOG, 'falló la llamada al PHP:', err instanceof Error ? err.message : err, { conversationId })
      return 'error_php'
    }

    // `duplicado` con asesor_id: el lead ya tenía asesor en XLR8, se le
    // asigna igual. Cualquier otro ok:false queda para derivación manual.
    const duplicadoConAsesor = body.motivo === 'duplicado' && body.asesor_id != null && body.asesor_id !== ''

    // Cupo lleno: vuelve a la cola con su turno (la hora original si
    // venía de la cola; ahora si fue un traspaso en vivo).
    if (body.ok !== true && typeof body.motivo === 'string' && MOTIVOS_EN_ESPERA.includes(body.motivo)) {
      const turno = opciones.desdeCola?.at ?? now
      if (!(await store.requeue(conversationId, turno, conv.assigned_agent_id ?? null))) {
        console.error(LOG, 'cupo lleno y no se pudo volver a la cola; queda para derivación manual', {
          conversationId,
        })
        return 'rechazada'
      }
      await store.appendNote(conversationId, NOTA_EN_ESPERA)
      return 'en_espera'
    }
    if (body.ok !== true && !duplicadoConAsesor) {
      console.error(LOG, 'PHP no derivó:', typeof body.motivo === 'string' ? body.motivo : 'sin motivo', {
        conversationId,
      })
      return 'rechazada'
    }

    const asesorId = Number(body.asesor_id)
    const asesorNombre = typeof body.asesor_nombre === 'string' ? body.asesor_nombre.trim() : ''
    const nombre = asesorNombre || (Number.isInteger(asesorId) ? `asesor ${asesorId}` : 'un asesor')
    const userId = Number.isInteger(asesorId) && asesorId > 0
      ? await store.findAgentByXlr8(conv.account_id, asesorId)
      : null

    const nota = motivoAtc
      ? `Derivado automáticamente a ATC (${motivoAtc})`
      : `Derivado automáticamente a ${nombre} (XLR8)`
    if (userId && (await store.assign(conversationId, userId))) {
      await store.appendNote(conversationId, nota)
      return 'asignada'
    }
    console.error(LOG, `sin usuario del CRM con ID XLR8 ${String(body.asesor_id)}; queda sin asignar`, {
      conversationId,
    })
    await store.appendNote(
      conversationId,
      `${nota}. Sin usuario del CRM con ese ID XLR8: queda sin asignar.`,
    )
    return 'sin_usuario'
  } catch (err) {
    console.error(LOG, err instanceof Error ? err.message : err, { conversationId })
    return 'error_php'
  }
}

/** Store real sobre Supabase (cliente service role). */
export function supabaseDerivacionStore(db: SupabaseClient): DerivacionStore {
  return {
    async loadConversation(id) {
      const base = 'account_id, channel, contact_id, assigned_agent_id, status'
      const full = await db
        .from('conversations')
        .select(`${base}, derivacion_historica, derivacion_clasificacion`)
        .eq('id', id)
        .maybeSingle()
      if (!full.error) return (full.data as ConversacionDerivacion | null) ?? null
      // Sin la migración 096 las columnas nuevas no existen: sigue sin ellas.
      const { data, error } = await db.from('conversations').select(base).eq('id', id).maybeSingle()
      if (error) throw new Error(`conversación: ${error.message}`)
      return (data as ConversacionDerivacion | null) ?? null
    },
    async loadContact(id) {
      const { data, error } = await db.from('contacts').select('phone, name').eq('id', id).maybeSingle()
      if (error) throw new Error(`contacto: ${error.message}`)
      return (data as { phone: string | null; name: string | null } | null) ?? null
    },
    async claim(conversationId) {
      const { data, error } = await db
        .from('conversations')
        .update({ derivado_auto_at: new Date().toISOString() })
        .eq('id', conversationId)
        .is('derivado_auto_at', null)
        .select('id')
      if (error) {
        // Sin la migración 088 la columna no existe: no deriva.
        console.error(LOG, 'no se pudo marcar la conversación:', error.message)
        return false
      }
      return (data ?? []).length > 0
    },
    async loadAdId(conversationId) {
      const { data } = await db
        .from('conversation_referrals')
        .select('source_id')
        .eq('conversation_id', conversationId)
        .not('source_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return ((data as { source_id?: string | null } | null)?.source_id ?? '').trim()
    },
    async findAgentByXlr8(accountId, xlr8UserId) {
      const { data, error } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('xlr8_user_id', xlr8UserId)
        .limit(1)
        .maybeSingle()
      if (error) {
        console.error(LOG, 'búsqueda de usuario XLR8 falló:', error.message)
        return null
      }
      return (data as { user_id?: string } | null)?.user_id ?? null
    },
    async assign(conversationId, userId) {
      if (!(await canAssignAgentToConversation(db, userId, conversationId))) return false
      const { error } = await db
        .from('conversations')
        .update({ assigned_agent_id: userId, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
      if (error) {
        console.error(LOG, 'no se pudo asignar:', error.message)
        return false
      }
      return true
    },
    async appendNote(conversationId, line) {
      const { data } = await db
        .from('conversations')
        .select('ai_handoff_summary')
        .eq('id', conversationId)
        .maybeSingle()
      const current = ((data as { ai_handoff_summary?: string | null } | null)?.ai_handoff_summary ?? '').trim()
      if (current.includes(line)) return
      const { error } = await db
        .from('conversations')
        .update({ ai_handoff_summary: current ? `${current}\n${line}` : line })
        .eq('id', conversationId)
      if (error) console.error(LOG, 'no se pudo guardar la nota:', error.message)
    },
    async enqueue(conversationId, at, agente) {
      const { data, error } = await db
        .from('conversations')
        .update({ derivacion_pendiente_at: at.toISOString(), derivacion_pendiente_agente: agente })
        .eq('id', conversationId)
        .is('derivado_auto_at', null)
        .is('derivacion_pendiente_at', null)
        .select('id')
      if (error) {
        // Sin la migración 089 la columna no existe: no queda en cola.
        console.error(LOG, 'no se pudo poner en cola:', error.message, { conversationId })
        return false
      }
      return (data ?? []).length > 0
    },
    async requeue(conversationId, at, agente) {
      const { data, error } = await db
        .from('conversations')
        .update({
          derivado_auto_at: null,
          derivacion_pendiente_at: at.toISOString(),
          derivacion_pendiente_agente: agente,
        })
        .eq('id', conversationId)
        .select('id')
      if (error) {
        console.error(LOG, 'no se pudo volver a poner en cola:', error.message, { conversationId })
        return false
      }
      return (data ?? []).length > 0
    },
    async hasPendingQueue(excludeConversationId) {
      const { data, error } = await db
        .from('conversations')
        .select('id')
        .not('derivacion_pendiente_at', 'is', null)
        .is('derivado_auto_at', null)
        .in('status', [...ESTADOS_DERIVABLES])
        .neq('id', excludeConversationId)
        .limit(1)
      if (error) {
        // Ante la duda se deriva directo, como antes.
        console.error(LOG, 'no se pudo revisar la cola:', error.message)
        return false
      }
      return (data ?? []).length > 0
    },
    async saveClasificacion(conversationId, clasificacion) {
      const { error } = await db
        .from('conversations')
        .update({ derivacion_clasificacion: clasificacion })
        .eq('id', conversationId)
      // Sin la migración 096 no se guarda: se reclasifica en el reintento.
      if (error) console.error(LOG, 'no se pudo guardar la clasificación:', error.message, { conversationId })
    },
    async listQueue(limit) {
      const { data, error } = await db
        .from('conversations')
        .select('id, derivacion_pendiente_at')
        .not('derivacion_pendiente_at', 'is', null)
        .is('derivado_auto_at', null)
        .order('derivacion_pendiente_at', { ascending: true })
        .limit(limit)
      if (error) {
        console.error(LOG, 'no se pudo leer la cola:', error.message)
        return []
      }
      return ((data ?? []) as { id: string; derivacion_pendiente_at: string }[]).map((r) => ({
        id: r.id,
        at: new Date(r.derivacion_pendiente_at),
      }))
    },
    async dequeue(conversationId) {
      const { data, error } = await db
        .from('conversations')
        // derivacion_pendiente_agente no se borra: RETURNING devuelve el
        // asesor que tenía al encolar (se sobrescribe al volver a encolar).
        .update({ derivacion_pendiente_at: null })
        .eq('id', conversationId)
        .not('derivacion_pendiente_at', 'is', null)
        .select('derivacion_pendiente_agente')
      if (error) {
        console.error(LOG, 'no se pudo sacar de la cola:', error.message, { conversationId })
        return null
      }
      const row = ((data ?? []) as { derivacion_pendiente_agente?: string | null }[])[0]
      return row ? { agente: row.derivacion_pendiente_agente ?? null } : null
    },
  }
}

export interface ColaResultado {
  /** Pasadas a derivarAuto. */
  derivadas: number
  /** Sacadas sin derivar: ya tomadas por un asesor, cerradas o inexistentes. */
  descartadas: number
  /** Devueltas a la cola por cupo lleno (corta la pasada). */
  enEspera: number
}

/**
 * Procesa la cola de fuera de horario, la más antigua primero. Solo
 * dentro de horario y con las variables completas; si no, la cola queda
 * intacta. Cada conversación se saca de la cola al reclamarla
 * (`dequeue`): dos pasadas simultáneas no la derivan dos veces. Si el
 * asesor asignado cambió desde que se encoló (alguien la tomó en el
 * CRM) o ya no está pending/open, sale sin derivar. Si el PHP responde
 * cupo lleno, la conversación vuelve a la cola con su hora original y
 * la pasada se corta.
 * Nunca lanza.
 */
export async function procesarColaDerivacion(deps: DerivacionDeps & { limite?: number }): Promise<ColaResultado> {
  const res: ColaResultado = { derivadas: 0, descartadas: 0, enEspera: 0 }
  const env = deps.env ?? derivacionEnv()
  const now = deps.now ?? new Date()
  if (!envListo(env) || !dentroDeHorario(now, deps.horario)) return res
  const { store } = deps
  try {
    const items = await store.listQueue(deps.limite ?? COLA_LIMITE_POR_PASADA)
    if (!items.length) return res
    if (!lineaDe(env)) {
      console.error(LOG, `falta XLR8_LINEA: ${items.length} conversación(es) siguen en cola sin derivar`)
      return res
    }
    for (const { id, at } of items) {
      try {
        const sacada = await store.dequeue(id)
        if (!sacada) continue
        const conv = await store.loadConversation(id)
        // El traspaso puede haberla asignado ya (handoffAgentId / assignTo):
        // solo se descarta si el asesor cambió DESPUÉS de encolar.
        const asesorCambio = (conv?.assigned_agent_id ?? null) !== sacada.agente
        if (!conv || asesorCambio || !ESTADOS_DERIVABLES.includes(conv.status ?? '')) {
          res.descartadas++
          continue
        }
        const r = await derivarAuto(id, { ...deps, env, now }, { desdeCola: { at } })
        if (r === 'en_espera') {
          // Cupo lleno: las siguientes también fallarían. Se reintenta en
          // la próxima pasada, la más antigua primero.
          res.enEspera++
          break
        }
        res.derivadas++
      } catch (err) {
        console.error(LOG, 'cola:', err instanceof Error ? err.message : err, { conversationId: id })
      }
    }
  } catch (err) {
    console.error(LOG, 'cola:', err instanceof Error ? err.message : err)
  }
  return res
}

let colaEnCurso = false

/**
 * Enganche del cron de flujos (cada minuto): procesa la cola si hay
 * variables, es horario y no hay otra pasada en curso. Nunca lanza.
 */
export async function runColaDerivacionSiToca(db: SupabaseClient, now: Date = new Date()): Promise<void> {
  if (colaEnCurso || !envListo(derivacionEnv()) || !dentroDeHorario(now)) return
  colaEnCurso = true
  try {
    await procesarColaDerivacion({ store: supabaseDerivacionStore(db), now, clasificar: clasificadorOpenAi(db) })
  } catch (err) {
    console.error(LOG, err)
  } finally {
    colaEnCurso = false
  }
}

/**
 * Punto de enganche del traspaso: programa la derivación en segundo
 * plano (`after()`, anidado dentro del `after()` del webhook o del
 * cron) para no retrasar al bot. Sin las variables de entorno no hace
 * nada. Fuera de un request (tests, scripts) corre suelta.
 */
export function programarDerivacionAuto(
  db: SupabaseClient,
  conversationId: string,
  opciones: DerivarOpciones = {},
): void {
  if (!envListo(derivacionEnv())) return
  const task = () =>
    derivarAuto(
      conversationId,
      { store: supabaseDerivacionStore(db), clasificar: clasificadorOpenAi(db) },
      opciones,
    ).then(
      () => undefined,
      (err: unknown) => console.error(LOG, err),
    )
  try {
    after(task)
  } catch {
    void task()
  }
}
