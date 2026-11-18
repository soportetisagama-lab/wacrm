import type { SupabaseClient } from '@supabase/supabase-js'

import { celularNueveDigitos, supabaseDerivacionStore, type DerivacionStore } from '@/lib/derivacion-auto'

// ============================================================
// Alertas de derivación (XLR8, alertas_derivacion.php).
//
// Cuando el asesor de un cliente de 30 días o más está apagado en la
// derivación automática, derivar_auto.php no crea el lead y deja una
// alerta; el chat queda sin asignar aquí. Cuando la ATC decide en XLR8
// (su mismo asesor u otro), el PHP crea el lead y llama a
// POST /api/xlr8/derivacion-atc para que el chat se asigne en XLR9 al
// asesor elegido (por su `profiles.xlr8_user_id`).
// ============================================================

const LOG = '[derivacion-alerta-atc]'

export interface AlertaAtcInput {
  /** conversation_id guardado en la alerta (puede venir vacío). */
  conversationId: string
  /** Celular del cliente: respaldo si no hay conversation_id. */
  celular: string
  /** ID XLR8 del asesor elegido por la ATC. */
  asesorId: number
  asesorNombre: string
  /** Asesor anterior (el del cliente); vacío si es el mismo. */
  antesDe: string
  /** true si la ATC lo derivó a su mismo asesor. */
  mismoAsesor: boolean
}

export type AlertaAtcResultado =
  | { ok: true; conversationId: string }
  | { ok: false; motivo: 'datos_invalidos' | 'sin_conversacion' | 'sin_usuario' | 'no_asignada' }

export interface AlertaAtcStore
  extends Pick<DerivacionStore, 'loadConversation' | 'findAgentByXlr8' | 'assign' | 'appendNote'> {
  /** Conversación de WhatsApp más reciente del contacto con ese celular (9 dígitos), o null. */
  findConversationByCelular(nueveDigitos: string): Promise<string | null>
}

/** Pura: valida el cuerpo que manda el PHP. */
export function leerAlertaAtc(body: unknown): AlertaAtcInput | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
  const asesorId = Number(b.asesor_id)
  if (!Number.isInteger(asesorId) || asesorId <= 0) return null
  const conversationId = texto(b.conversation_id)
  const celular = texto(b.celular)
  if (!conversationId && !celularNueveDigitos(celular)) return null
  return {
    conversationId,
    celular,
    asesorId,
    asesorNombre: texto(b.asesor_nombre),
    antesDe: texto(b.antes_de),
    mismoAsesor: b.mismo_asesor === true,
  }
}

/** Pura: nota interna que queda en el chat. */
export function notaDerivadoPorAtc(input: AlertaAtcInput): string {
  const nombre = input.asesorNombre || `asesor ${input.asesorId}`
  if (input.mismoAsesor) return `Derivado por ATC a su mismo asesor ${nombre} (XLR8)`
  return `Derivado por ATC a ${nombre} (XLR8)${input.antesDe ? `, antes cliente de ${input.antesDe}` : ''}`
}

/** Asigna en XLR9 el chat de la alerta al asesor que eligió la ATC. */
export async function asignarDesdeAlertaAtc(
  store: AlertaAtcStore,
  input: AlertaAtcInput,
): Promise<AlertaAtcResultado> {
  let conversationId: string | null = null
  if (input.conversationId) {
    const conv = await store.loadConversation(input.conversationId).catch(() => null)
    if (conv) conversationId = input.conversationId
  }
  if (!conversationId) {
    const nueve = celularNueveDigitos(input.celular)
    if (nueve) conversationId = await store.findConversationByCelular(nueve)
  }
  if (!conversationId) return { ok: false, motivo: 'sin_conversacion' }

  const conv = await store.loadConversation(conversationId)
  if (!conv) return { ok: false, motivo: 'sin_conversacion' }

  const userId = await store.findAgentByXlr8(conv.account_id, input.asesorId)
  if (!userId) {
    console.error(LOG, `sin usuario del CRM con ID XLR8 ${input.asesorId}`, { conversationId })
    await store.appendNote(conversationId, `${notaDerivadoPorAtc(input)}. Sin usuario del CRM con ese ID XLR8: queda sin asignar.`)
    return { ok: false, motivo: 'sin_usuario' }
  }
  if (conv.assigned_agent_id !== userId && !(await store.assign(conversationId, userId))) {
    return { ok: false, motivo: 'no_asignada' }
  }
  await store.appendNote(conversationId, notaDerivadoPorAtc(input))
  return { ok: true, conversationId }
}

/** Store real sobre Supabase (cliente service role). */
export function supabaseAlertaAtcStore(db: SupabaseClient): AlertaAtcStore {
  const base = supabaseDerivacionStore(db)
  return {
    loadConversation: base.loadConversation,
    findAgentByXlr8: base.findAgentByXlr8,
    assign: base.assign,
    appendNote: base.appendNote,
    async findConversationByCelular(nueveDigitos) {
      const { data: contactos, error } = await db
        .from('contacts')
        .select('id, phone')
        .like('phone', `%${nueveDigitos}`)
      if (error || !contactos) return null
      const ids = (contactos as { id: string; phone: string | null }[])
        .filter((c) => celularNueveDigitos(c.phone) === nueveDigitos)
        .map((c) => c.id)
      if (ids.length === 0) return null
      const { data } = await db
        .from('conversations')
        .select('id')
        .in('contact_id', ids)
        .or('channel.eq.whatsapp,channel.is.null')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return (data as { id?: string } | null)?.id ?? null
    },
  }
}
