import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { canAssignAgentToConversation } from '@/lib/conversations/assignee-guard'

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
const USER_AGENT = 'wacrm-inox/1.0'

/** Celular peruano en 9 dígitos sin el 51, o null si no lo es. */
export function celularNueveDigitos(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 9) return digits
  if (digits.length === 11 && digits.startsWith('51')) return digits.slice(2)
  return null
}

/** True cuando el celular está permitido por el MODO PRUEBA. */
export function debeDerivarCelular(phone: string | null | undefined): boolean {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (!digits) return false
  const nueve = celularNueveDigitos(digits)
  return NUMEROS_PRUEBA.includes(digits) || (nueve !== null && NUMEROS_PRUEBA.includes(nueve))
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

/** Acceso a datos que usa la derivación (inyectable en los tests). */
export interface DerivacionStore {
  loadConversation(id: string): Promise<{ account_id: string; channel: string | null; contact_id: string } | null>
  loadContact(id: string): Promise<{ phone: string | null; name: string | null } | null>
  /** Marca la conversación como derivada; false si ya lo estaba (o falla). */
  claim(conversationId: string): Promise<boolean>
  /** ID del anuncio de Meta (click-to-WhatsApp) de la conversación, o ''. */
  loadAdId(conversationId: string): Promise<string>
  /** user_id del perfil con ese ID XLR8 en la cuenta, o null. */
  findAgentByXlr8(accountId: string, xlr8UserId: number): Promise<string | null>
  /** Asigna la conversación; false si no se pudo. */
  assign(conversationId: string, userId: string): Promise<boolean>
  /** Agrega una línea a la nota interna del traspaso. */
  appendNote(conversationId: string, line: string): Promise<void>
}

export type DerivacionResultado =
  | 'sin_env'
  | 'sin_conversacion'
  | 'no_whatsapp'
  | 'sin_celular'
  | 'no_es_prueba'
  | 'ya_derivada'
  | 'error_php'
  | 'rechazada'
  | 'asignada'
  | 'sin_usuario'

interface RespuestaPhp {
  ok?: unknown
  asesor_id?: unknown
  asesor_nombre?: unknown
  motivo?: unknown
}

/**
 * Deriva la conversación al PHP si cumple todas las condiciones.
 * Nunca lanza: cualquier error se registra y la conversación queda
 * para derivación manual.
 */
export async function derivarAuto(
  conversationId: string,
  deps: { store: DerivacionStore; env?: DerivacionEnv; fetchFn?: typeof fetch },
): Promise<DerivacionResultado> {
  const env = deps.env ?? derivacionEnv()
  if (!envListo(env)) return 'sin_env'
  const { store } = deps
  const fetchFn = deps.fetchFn ?? fetch
  try {
    const conv = await store.loadConversation(conversationId)
    if (!conv) return 'sin_conversacion'
    if ((conv.channel ?? 'whatsapp') !== 'whatsapp') return 'no_whatsapp'

    const contact = await store.loadContact(conv.contact_id)
    const celular = celularNueveDigitos(contact?.phone)
    if (!celular) return 'sin_celular'
    if (!debeDerivarCelular(contact?.phone)) return 'no_es_prueba'

    // Reclamada ANTES de llamar: una sola llamada por conversación,
    // aunque el PHP falle o dos traspasos coincidan.
    if (!(await store.claim(conversationId))) return 'ya_derivada'

    const codigoAnuncio = await store.loadAdId(conversationId).catch(() => '')
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
          linea: env.linea?.trim() || 'INOX',
          celular,
          nombre: contact?.name?.trim() ?? '',
          codigo_anuncio: codigoAnuncio,
          conversation_id: conversationId,
        }),
        signal: AbortSignal.timeout(DERIVAR_TIMEOUT_MS),
        cache: 'no-store',
      })
      body = ((await res.json().catch(() => null)) ?? {}) as RespuestaPhp
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

    if (userId && (await store.assign(conversationId, userId))) {
      await store.appendNote(conversationId, `Derivado automáticamente a ${nombre} (XLR8)`)
      return 'asignada'
    }
    console.error(LOG, `sin usuario del CRM con ID XLR8 ${String(body.asesor_id)}; queda sin asignar`, {
      conversationId,
    })
    await store.appendNote(
      conversationId,
      `Derivado automáticamente a ${nombre} (XLR8). Sin usuario del CRM con ese ID XLR8: queda sin asignar.`,
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
      const { data, error } = await db
        .from('conversations')
        .select('account_id, channel, contact_id')
        .eq('id', id)
        .maybeSingle()
      if (error) throw new Error(`conversación: ${error.message}`)
      return (data as { account_id: string; channel: string | null; contact_id: string } | null) ?? null
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
  }
}

/**
 * Punto de enganche del traspaso: programa la derivación en segundo
 * plano (`after()`, anidado dentro del `after()` del webhook o del
 * cron) para no retrasar al bot. Sin las variables de entorno no hace
 * nada. Fuera de un request (tests, scripts) corre suelta.
 */
export function programarDerivacionAuto(db: SupabaseClient, conversationId: string): void {
  if (!envListo(derivacionEnv())) return
  const task = () =>
    derivarAuto(conversationId, { store: supabaseDerivacionStore(db) }).then(
      () => undefined,
      (err: unknown) => console.error(LOG, err),
    )
  try {
    after(task)
  } catch {
    void task()
  }
}
