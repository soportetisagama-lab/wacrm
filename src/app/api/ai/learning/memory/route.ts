import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sanitizeMemory } from '@/lib/ai/learning/memory'

const MAX_ROWS = 200

interface MemoryRow {
  contact_id: string
  memory: unknown
  updated_at: string
  contacts: { name: string | null } | { name: string | null }[] | null
}

/**
 * GET /api/ai/learning/memory  (admin+)
 *
 * Read-only list of the per-customer AI memory for the "Aprendizaje"
 * tab in Agentes IA. Admin-only, mirroring the contact_ai_memory
 * SELECT policy (migration 079): advisors never see it.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data, error } = await supabase
      .from('contact_ai_memory')
      .select('contact_id, memory, updated_at, contacts ( name )')
      .eq('account_id', accountId)
      .neq('memory', '{}')
      .order('updated_at', { ascending: false })
      .limit(MAX_ROWS)

    if (error) {
      // Migration 079 not applied yet: show the empty state, not an error.
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return NextResponse.json({ items: [], ready: false })
      }
      console.error('[ai/learning/memory GET] error:', error.message)
      return NextResponse.json({ error: 'Failed to load memory' }, { status: 500 })
    }

    const items = ((data ?? []) as MemoryRow[])
      .map((r) => {
        const contact = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts
        return {
          contact_id: r.contact_id,
          contact_name: contact?.name?.trim() || null,
          memory: sanitizeMemory(r.memory),
          updated_at: r.updated_at,
        }
      })
      .filter((r) => Object.keys(r.memory).length > 0)

    return NextResponse.json({ items, ready: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
