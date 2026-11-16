import type { SupabaseClient } from '@supabase/supabase-js'

import { HORARIO_DERIVACION, NOTA_PLANTILLA_REAPERTURA } from '@/lib/derivacion-auto'
import { diaAnterior, fechaLima } from '@/lib/feriados-peru'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateToPhone } from '@/lib/whatsapp/send-template-to-phone'
import type { MessageTemplate } from '@/types'

// ============================================================
// Plantilla de reapertura (lunes y día después de feriado, 7:00 Lima).
//
// Los chats que quedaron en la cola de derivación durante el domingo o
// un feriado llegan al lunes con la ventana de 24 h de WhatsApp cerrada:
// el asesor no podría escribirles. A las 7:00 se les envía la plantilla
// aprobada `reapertura_consulta` (botón "Quiero que me atiendan") y se
// deja la nota "Plantilla enviada 7:00 (dd/mm)". A las 8:00 la cola los
// deriva como siempre.
//
// Solo si REAPERTURA_PLANTILLA=1 (apagado por defecto). Nombre e idioma:
// REAPERTURA_PLANTILLA_NOMBRE (reapertura_consulta) y
// REAPERTURA_PLANTILLA_IDIOMA (es_PE).
// Una sola vez por chat y día: la nota hace de marca.
// ============================================================

const LOG = '[derivacion-reapertura]'
const VENTANA_24H_MS = 24 * 60 * 60_000
/** Chats revisados como máximo por pasada. */
export const REAPERTURA_LIMITE = 200
/** Ventana de envío (Lima): 07:00 a 07:30. */
const DESDE_MIN = 7 * 60
const HASTA_MIN = 7 * 60 + 30

type Env = Record<string, string | undefined>

export interface ConfigReapertura {
  activa: boolean
  plantilla: string
  idioma: string
}

export function configReapertura(env: Env = process.env): ConfigReapertura {
  return {
    activa: env.REAPERTURA_PLANTILLA?.trim() === '1',
    plantilla: env.REAPERTURA_PLANTILLA_NOMBRE?.trim() || 'reapertura_consulta',
    idioma: env.REAPERTURA_PLANTILLA_IDIOMA?.trim() || 'es_PE',
  }
}

/** True si en esa fecha de Lima no se deriva (domingo o feriado). */
function diaSinDerivacion(fecha: string, feriado: (f: string) => boolean): boolean {
  const dia = new Date(`${fecha}T12:00:00Z`).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6
  return HORARIO_DERIVACION.jornada[dia] === null || feriado(fecha)
}

/**
 * Pura: fecha de Lima si ahora toca enviar (07:00–07:29 de un día con
 * derivación cuyo día anterior no tuvo: lunes o día después de feriado),
 * o null. Por defecto los feriados cuentan solo si pausan la derivación
 * (FERIADOS_PAUSAN_DERIVACION=1): si no, ese día sí se derivó.
 */
export function tocaReapertura(
  now: Date,
  feriado: (f: string) => boolean = (f) => HORARIO_DERIVACION.esFeriado?.(f) ?? false,
): string | null {
  const lima = new Date(now.getTime() - 5 * 60 * 60_000)
  const minuto = lima.getUTCHours() * 60 + lima.getUTCMinutes()
  if (minuto < DESDE_MIN || minuto >= HASTA_MIN) return null
  const hoy = fechaLima(now)
  if (diaSinDerivacion(hoy, feriado)) return null
  return diaSinDerivacion(diaAnterior(hoy), feriado) ? hoy : null
}

/** Pura: true si la ventana de 24 h ya cerró (o no hay mensaje del cliente). */
export function ventanaCerrada(ultimoDelCliente: Date | null, now: Date): boolean {
  return !ultimoDelCliente || now.getTime() - ultimoDelCliente.getTime() >= VENTANA_24H_MS
}

/** Nota del día, p. ej. "Plantilla enviada 7:00 (16/11)". */
export function notaReapertura(fecha: string): string {
  return `${NOTA_PLANTILLA_REAPERTURA} (${fecha.slice(8, 10)}/${fecha.slice(5, 7)})`
}

export interface ReaperturaResultado {
  revisados: number
  enviados: number
  fallidos: number
}

interface ConvCola {
  id: string
  account_id: string
  contact_id: string
  ai_handoff_summary: string | null
}

/** Envía la plantilla a los chats en cola con la ventana cerrada. Nunca lanza. */
export async function enviarReaperturas(
  db: SupabaseClient,
  fecha: string,
  now: Date,
  cfg: ConfigReapertura = configReapertura(),
): Promise<ReaperturaResultado> {
  const res: ReaperturaResultado = { revisados: 0, enviados: 0, fallidos: 0 }
  const nota = notaReapertura(fecha)
  const { data, error } = await db
    .from('conversations')
    .select('id, account_id, contact_id, ai_handoff_summary')
    .eq('channel', 'whatsapp')
    .in('status', ['pending', 'open'])
    .not('derivacion_pendiente_at', 'is', null)
    .is('derivado_auto_at', null)
    .order('derivacion_pendiente_at', { ascending: true })
    .limit(REAPERTURA_LIMITE)
  if (error) {
    console.error(LOG, 'no se pudo leer la cola:', error.message)
    return res
  }
  const credenciales = new Map<string, { phoneNumberId: string; accessToken: string; template?: MessageTemplate } | null>()

  for (const conv of (data ?? []) as ConvCola[]) {
    res.revisados++
    try {
      if ((conv.ai_handoff_summary ?? '').includes(nota)) continue
      const { data: ultimo } = await db
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conv.id)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const at = (ultimo as { created_at?: string } | null)?.created_at
      if (!ventanaCerrada(at ? new Date(at) : null, now)) continue

      if (!credenciales.has(conv.account_id)) {
        credenciales.set(conv.account_id, await cargarCredenciales(db, conv.account_id, cfg))
      }
      const cred = credenciales.get(conv.account_id)
      if (!cred) continue

      const { data: contacto } = await db.from('contacts').select('phone').eq('id', conv.contact_id).maybeSingle()
      const phone = (contacto as { phone?: string | null } | null)?.phone
      if (!phone) continue

      const envio = await sendTemplateToPhone({
        phoneNumberId: cred.phoneNumberId,
        accessToken: cred.accessToken,
        phone,
        templateName: cfg.plantilla,
        language: cfg.idioma,
        template: cred.template,
      })
      if (envio.status !== 'sent') {
        res.fallidos++
        console.error(LOG, 'no se envió la plantilla:', envio.error, { conversationId: conv.id })
        continue
      }
      res.enviados++
      await db.from('messages').insert({
        conversation_id: conv.id,
        sender_type: 'bot',
        content_type: 'template',
        content_text: cred.template?.body_text ?? null,
        template_name: cfg.plantilla,
        message_id: envio.messageId,
        status: 'sent',
      })
      const resumen = (conv.ai_handoff_summary ?? '').trim()
      const { error: errNota } = await db
        .from('conversations')
        .update({ ai_handoff_summary: resumen ? `${resumen}\n${nota}` : nota })
        .eq('id', conv.id)
      if (errNota) {
        // Sin la nota podría reenviarse en otra pasada: cuenta como fallo.
        res.fallidos++
        console.error(LOG, 'enviada, pero no se guardó la nota:', errNota.message, { conversationId: conv.id })
      }
    } catch (err) {
      res.fallidos++
      console.error(LOG, err instanceof Error ? err.message : err, { conversationId: conv.id })
    }
  }
  return res
}

async function cargarCredenciales(
  db: SupabaseClient,
  accountId: string,
  cfg: ConfigReapertura,
): Promise<{ phoneNumberId: string; accessToken: string; template?: MessageTemplate } | null> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  const c = config as { phone_number_id?: string; access_token?: string } | null
  if (!c?.phone_number_id || !c.access_token) {
    console.error(LOG, 'WhatsApp no está configurado en la cuenta', { accountId })
    return null
  }
  let accessToken: string
  try {
    accessToken = decrypt(c.access_token)
  } catch {
    console.error(LOG, 'no se pudo leer el token de WhatsApp', { accountId })
    return null
  }
  const { data: tpl } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', cfg.plantilla)
    .eq('language', cfg.idioma)
    .maybeSingle()
  return { phoneNumberId: c.phone_number_id, accessToken, template: (tpl as MessageTemplate | null) ?? undefined }
}

/** Pasadas como máximo por día cuando hay fallos (p. ej. plantilla aún no aprobada). */
export const REAPERTURA_MAX_PASADAS = 3

const g = globalThis as {
  __wacrmReapertura?: { corriendo: boolean; hecha: string | null; pasadas: Record<string, number> }
}

/** Entrada del cron de flujos (cada minuto). Apagada sin REAPERTURA_PLANTILLA=1. Nunca lanza. */
export async function runReaperturaSiToca(db: SupabaseClient, now: Date = new Date()): Promise<void> {
  const cfg = configReapertura()
  if (!cfg.activa) return
  const fecha = tocaReapertura(now)
  if (!fecha) return
  const s = (g.__wacrmReapertura ??= { corriendo: false, hecha: null, pasadas: {} })
  if (s.corriendo || s.hecha === fecha) return
  s.corriendo = true
  try {
    const r = await enviarReaperturas(db, fecha, now, cfg)
    console.log(LOG, fecha, r)
    // Con fallos se reintenta en la próxima pasada (la nota evita repetir),
    // hasta REAPERTURA_MAX_PASADAS por día.
    s.pasadas = { [fecha]: (s.pasadas[fecha] ?? 0) + 1 }
    if (r.fallidos === 0 || s.pasadas[fecha] >= REAPERTURA_MAX_PASADAS) s.hecha = fecha
  } catch (err) {
    console.error(LOG, err)
  } finally {
    s.corriendo = false
  }
}
