import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  asesorReal,
  asignarPerfilSinNumero,
  esPerfilSinNumero,
  perfilSinNumeroId,
  reiniciarCachePerfilSinNumero,
} from './perfil-sin-numero'

type Fila = { user_id: string; account_id: string; full_name: string; account_role?: string }

/** Supabase falso: lecturas de `profiles` y la escritura condicionada en `conversations`. */
function fakeDb(
  perfiles: Fila[],
  conv: { assigned_agent_id: string | null; channel?: string } = { assigned_agent_id: null },
) {
  const lecturas = { profiles: 0 }
  const updates: Record<string, unknown>[] = []
  const db = {
    from(table: string) {
      const filtros: Record<string, unknown> = {}
      let payload: Record<string, unknown> | null = null
      const q = {
        select: () => q,
        ilike: () => q,
        limit: () => q,
        eq: (col: string, val: unknown) => {
          filtros[col] = val
          return q
        },
        is: (col: string, val: unknown) => {
          filtros[`is:${col}`] = val
          return q
        },
        update: (p: Record<string, unknown>) => {
          payload = p
          return q
        },
        maybeSingle: async () => {
          if (table === 'profiles') {
            const p = perfiles.find((f) => f.user_id === filtros.user_id)
            return { data: p ? { account_role: p.account_role ?? 'user' } : null, error: null }
          }
          return { data: { channel: conv.channel ?? 'whatsapp' }, error: null }
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === 'profiles') {
            lecturas.profiles++
            resolve({ data: perfiles, error: null })
            return
          }
          if (payload) {
            const libre = conv.assigned_agent_id === null
            if (libre) {
              conv.assigned_agent_id = payload.assigned_agent_id as string
              updates.push(payload)
            }
            resolve({ data: libre ? [{ id: filtros.id }] : [], error: null })
            return
          }
          resolve({ data: [], error: null })
        },
      }
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, lecturas, updates, conv }
}

const ARROBA: Fila = { user_id: 'perfil-arroba', account_id: 'acc-1', full_name: ' @ ' }
const OTRO: Fila = { user_id: 'user-7', account_id: 'acc-1', full_name: 'Ana @ Ventas' }

beforeEach(() => {
  reiniciarCachePerfilSinNumero()
  vi.stubEnv('DERIVACION_CON_IA', 'true')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('perfil "@" con DERIVACION_CON_IA encendido', () => {
  it('lo encuentra por trim(full_name) = "@" en la cuenta', async () => {
    const { db } = fakeDb([OTRO, ARROBA])
    expect(await perfilSinNumeroId(db, 'acc-1')).toBe('perfil-arroba')
    expect(await perfilSinNumeroId(db, 'acc-2')).toBeNull()
    expect(await esPerfilSinNumero(db, 'perfil-arroba')).toBe(true)
    expect(await esPerfilSinNumero(db, 'user-7')).toBe(false)
  })

  it('usa una caché corta: una sola lectura de profiles', async () => {
    const { db, lecturas } = fakeDb([ARROBA])
    await perfilSinNumeroId(db, 'acc-1')
    await esPerfilSinNumero(db, 'perfil-arroba')
    await asesorReal(db, 'perfil-arroba')
    expect(lecturas.profiles).toBe(1)
  })

  it('asesorReal: null para "@" o sin asesor; el id para un asesor real', async () => {
    const { db } = fakeDb([ARROBA])
    expect(await asesorReal(db, 'perfil-arroba')).toBeNull()
    expect(await asesorReal(db, null)).toBeNull()
    expect(await asesorReal(db, 'user-7')).toBe('user-7')
  })

  it('asigna a "@" un chat sin asesor', async () => {
    const { db, conv } = fakeDb([ARROBA])
    expect(await asignarPerfilSinNumero(db, { accountId: 'acc-1', conversationId: 'conv-1' })).toBe(true)
    expect(conv.assigned_agent_id).toBe('perfil-arroba')
  })

  it('no toca un chat que ya tiene asesor', async () => {
    const { db, conv, updates } = fakeDb([ARROBA], { assigned_agent_id: 'user-7' })
    expect(await asignarPerfilSinNumero(db, { accountId: 'acc-1', conversationId: 'conv-1' })).toBe(false)
    expect(conv.assigned_agent_id).toBe('user-7')
    expect(updates).toEqual([])
  })

  it('sin perfil "@" no hace nada', async () => {
    const { db, updates } = fakeDb([OTRO])
    expect(await asignarPerfilSinNumero(db, { accountId: 'acc-1', conversationId: 'conv-1' })).toBe(false)
    expect(updates).toEqual([])
  })

  it('respeta el guard de Community Manager (solo Messenger / Instagram)', async () => {
    const cm: Fila = { ...ARROBA, account_role: 'community_manager' }
    const { db, updates } = fakeDb([cm], { assigned_agent_id: null, channel: 'whatsapp' })
    expect(await asignarPerfilSinNumero(db, { accountId: 'acc-1', conversationId: 'conv-1' })).toBe(false)
    expect(updates).toEqual([])
  })
})

describe('perfil "@" con DERIVACION_CON_IA apagado', () => {
  beforeEach(() => {
    vi.stubEnv('DERIVACION_CON_IA', '')
  })

  it('no lo resuelve, no lo asigna y "@" es un asesor más', async () => {
    const { db, lecturas, updates } = fakeDb([ARROBA])
    expect(await perfilSinNumeroId(db, 'acc-1')).toBeNull()
    expect(await esPerfilSinNumero(db, 'perfil-arroba')).toBe(false)
    expect(await asesorReal(db, 'perfil-arroba')).toBe('perfil-arroba')
    expect(await asignarPerfilSinNumero(db, { accountId: 'acc-1', conversationId: 'conv-1' })).toBe(false)
    expect(lecturas.profiles).toBe(0)
    expect(updates).toEqual([])
  })
})
