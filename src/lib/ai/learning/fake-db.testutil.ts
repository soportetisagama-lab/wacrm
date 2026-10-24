import type { SupabaseClient } from '@supabase/supabase-js'

// Minimal in-memory stand-in for the supabase-js query builder, for the
// learning tests only. Supports the calls the learning code makes:
// select / insert / update / upsert, eq / neq / gt / gte / lt / in,
// order / limit / maybeSingle, `{ count, head }`, and rpc (returns []).
// `.or()` filters are ignored (they only narrow message types).

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

let idSeq = 0
export function fakeId(): string {
  idSeq += 1
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`
}

class Query implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private filters: Filter[] = []
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private payload: Row | Row[] | null = null
  private conflict: string[] = []
  private returning = false
  private single = false
  private head = false
  private orderBy: { col: string; asc: boolean } | null = null
  private max: number | null = null

  constructor(
    private tables: Record<string, Row[]>,
    private table: string,
  ) {}

  private rows(): Row[] {
    this.tables[this.table] ??= []
    return this.tables[this.table]
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op !== 'select') this.returning = true
    if (opts?.head) this.head = true
    return this
  }
  insert(p: Row | Row[]) {
    this.op = 'insert'
    this.payload = p
    return this
  }
  update(p: Row) {
    this.op = 'update'
    this.payload = p
    return this
  }
  upsert(p: Row, opts?: { onConflict?: string }) {
    this.op = 'upsert'
    this.payload = p
    this.conflict = opts?.onConflict?.split(',') ?? ['id']
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v)
    return this
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v)
    return this
  }
  gt(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? '') > v)
    return this
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? '') >= v)
    return this
  }
  lt(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? '') < v)
    return this
  }
  lte(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? '') <= v)
    return this
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v)
    return this
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]))
    return this
  }
  or() {
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false }
    return this
  }
  limit(n: number) {
    this.max = n
    return this
  }
  maybeSingle() {
    this.single = true
    return this
  }

  private match(): Row[] {
    return this.rows().filter((r) => this.filters.every((f) => f(r)))
  }

  private run(): { data: unknown; error: unknown; count?: number } {
    const now = new Date().toISOString()
    if (this.op === 'insert') {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[]
      const made: Row[] = list.map((p) => ({ id: fakeId(), created_at: now, updated_at: now, ...p }))
      // ai_job_runs lock: UNIQUE (job, run_key)
      if (this.table === 'ai_job_runs' && made.some((m) => this.rows().some((r) => r.job === m.job && r.run_key === m.run_key))) {
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      }
      this.rows().push(...made)
      return this.out(made)
    }
    if (this.op === 'upsert') {
      const p = this.payload as Row
      const hit = this.rows().find((r) => this.conflict.every((c) => r[c] === p[c]))
      if (hit) Object.assign(hit, p, { updated_at: now })
      else this.rows().push({ id: fakeId(), created_at: now, updated_at: now, ...p })
      return { data: null, error: null }
    }
    if (this.op === 'update') {
      const hits = this.match()
      for (const h of hits) Object.assign(h, this.payload)
      return this.out(hits)
    }
    if (this.op === 'delete') {
      const hits = new Set(this.match())
      this.tables[this.table] = this.rows().filter((r) => !hits.has(r))
      return { data: null, error: null }
    }
    let rows = this.match()
    if (this.orderBy) {
      const { col, asc } = this.orderBy
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
    }
    if (this.max !== null) rows = rows.slice(0, this.max)
    if (this.head) return { data: null, error: null, count: rows.length }
    return this.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }
  }

  private out(rows: Row[]) {
    if (!this.returning) return { data: null, error: null }
    return this.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }
  }

  then<A, B>(
    onfulfilled?: ((v: { data: unknown; error: unknown; count?: number }) => A | PromiseLike<A>) | null,
    onrejected?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

export function fakeDb(tables: Record<string, Row[]> = {}): { db: SupabaseClient; tables: Record<string, Row[]> } {
  const db = {
    from: (t: string) => new Query(tables, t),
    rpc: async () => ({ data: [], error: null }),
  } as unknown as SupabaseClient
  return { db, tables }
}
