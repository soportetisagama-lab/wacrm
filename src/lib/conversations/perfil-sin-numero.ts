import type { SupabaseClient } from '@supabase/supabase-js'
import { canAssignAgentToConversation } from './assignee-guard'
import { derivacionConIaActiva } from '@/lib/derivacion-con-ia'

/**
 * Perfil "@" (`profiles.full_name` = '@', sin usuario de acceso): recibe
 * los chats de WhatsApp que entran sin número de teléfono para que no
 * queden "Sin asignar". Nunca escribe; para la derivación, los traspasos
 * y los flujos cuenta como "sin asesor", así el chat pasa a un asesor
 * real apenas llega el número.
 *
 * Todo depende del interruptor DERIVACION_CON_IA (lib/derivacion-con-ia):
 * apagado, "@" es un asesor más y nada cambia.
 */
export const NOMBRE_PERFIL_SIN_NUMERO = '@'

/** Caché corta: el perfil casi nunca cambia y se consulta en cada mensaje. */
export const PERFIL_SIN_NUMERO_CACHE_MS = 60_000

interface PerfilSinNumero {
  userId: string
  accountId: string | null
}

let cache: { at: number; perfiles: PerfilSinNumero[] } | null = null

/** Solo para los tests. */
export function reiniciarCachePerfilSinNumero(): void {
  cache = null
}

/** Perfiles "@" de todas las cuentas. Un error de lectura da [] (sin caché). */
async function cargarPerfiles(db: SupabaseClient): Promise<PerfilSinNumero[]> {
  if (cache && Date.now() - cache.at < PERFIL_SIN_NUMERO_CACHE_MS) return cache.perfiles
  try {
    const { data, error } = await db
      .from('profiles')
      .select('user_id, account_id, full_name')
      .ilike('full_name', `%${NOMBRE_PERFIL_SIN_NUMERO}%`)
      .limit(100)
    if (error) {
      console.error('[perfil-sin-numero] no se pudo leer el perfil "@":', error.message)
      return []
    }
    const perfiles = ((data ?? []) as { user_id?: string | null; account_id?: string | null; full_name?: string | null }[])
      .filter((p) => typeof p.user_id === 'string' && (p.full_name ?? '').trim() === NOMBRE_PERFIL_SIN_NUMERO)
      .map((p) => ({ userId: p.user_id as string, accountId: p.account_id ?? null }))
    cache = { at: Date.now(), perfiles }
    return perfiles
  } catch (err) {
    console.error('[perfil-sin-numero] lectura del perfil "@" falló:', err)
    return []
  }
}

/** user_id del perfil "@" de la cuenta, o null (interruptor apagado o no existe). */
export async function perfilSinNumeroId(db: SupabaseClient, accountId: string): Promise<string | null> {
  if (!derivacionConIaActiva()) return null
  const perfiles = await cargarPerfiles(db)
  return perfiles.find((p) => p.accountId === accountId)?.userId ?? null
}

/** True si `userId` es un perfil "@" (y el interruptor está encendido). */
export async function esPerfilSinNumero(
  db: SupabaseClient,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId || !derivacionConIaActiva()) return false
  const perfiles = await cargarPerfiles(db)
  return perfiles.some((p) => p.userId === userId)
}

/**
 * El asesor real del chat: el asignado, o null si no hay o es "@". Para
 * las guardas "si ya tiene asesor no hagas X". Con el interruptor apagado
 * devuelve el asignado tal cual.
 */
export async function asesorReal(
  db: SupabaseClient,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null
  return (await esPerfilSinNumero(db, userId)) ? null : userId
}

/**
 * Asigna al perfil "@" un chat sin asesor. Quien llama comprueba antes
 * que el contacto no tiene número y que la derivación está configurada
 * (lib/derivacion-auto derivacionConfigurada). No hace nada si el
 * interruptor está apagado, si el perfil no existe, si el guard de
 * Community Manager no lo permite o si el chat ya tiene asesor
 * (escritura condicionada a `assigned_agent_id` null). Nunca lanza.
 */
export async function asignarPerfilSinNumero(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string },
): Promise<boolean> {
  try {
    const userId = await perfilSinNumeroId(db, args.accountId)
    if (!userId) return false
    if (!(await canAssignAgentToConversation(db, userId, args.conversationId))) return false
    const { data, error } = await db
      .from('conversations')
      .update({ assigned_agent_id: userId, updated_at: new Date().toISOString() })
      .eq('id', args.conversationId)
      .is('assigned_agent_id', null)
      .select('id')
    if (error) {
      console.error('[perfil-sin-numero] no se pudo asignar a "@":', error.message)
      return false
    }
    return (data ?? []).length > 0
  } catch (err) {
    console.error('[perfil-sin-numero] asignación a "@" falló:', err)
    return false
  }
}
