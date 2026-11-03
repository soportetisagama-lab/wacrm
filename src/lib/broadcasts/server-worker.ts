import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { sendTemplateToPhone } from '@/lib/whatsapp/send-template-to-phone'
import { resolveVariables, type VariableMapping } from '@/lib/broadcasts/variables'
import {
  DELIVERED_LIKE_STATUSES,
  headerMediaProblem,
  isMediaHeaderType,
  pickResumeHeaderMediaUrl,
  storedHeaderMediaUrl,
} from '@/lib/broadcasts/send-loop'
import {
  LEASE_KEY,
  LEASE_RENEW_MS,
  SERVER_BATCH_PAUSE_MS,
  SERVER_BATCH_SIZE,
  finalBroadcastStatus,
  leaseBlocks,
  readLease,
  selectBatch,
  withLease,
  withoutLease,
  type SendLease,
} from '@/lib/broadcasts/server-send-logic'
import type { Contact, MessageTemplate } from '@/types'

// ============================================================
// Server-side broadcast sender. The browser only creates the broadcast
// and its 'pending' recipients; POST /api/broadcasts/[id]/start (and
// the in-process sweeper, see instrumentation-node.ts) call
// startBroadcastSend(), which claims the broadcast and runs the send
// loop detached from the request, so closing the tab does not stop it.
//
// Double-send guards:
//   - in-process: a Set of running broadcast ids on globalThis (route
//     bundles do not share module state, but they share the process);
//   - across processes: a lease in audience_filter.sendLease, claimed
//     with a compare-and-set update and renewed every 30 s. Another
//     process skips the broadcast while the heartbeat is < 2 min old.
// ============================================================

interface WorkerState {
  owner: string
  running: Set<string>
}

const g = globalThis as { __wacrmBroadcastWorker?: WorkerState }

function workerState(): WorkerState {
  g.__wacrmBroadcastWorker ??= { owner: randomUUID(), running: new Set() }
  return g.__wacrmBroadcastWorker
}

export type StartOutcome =
  | { kind: 'started'; pending: number }
  | { kind: 'already_running' }
  | { kind: 'nothing_pending' }
  | { kind: 'error'; status: number; message: string }

export interface StartOptions {
  /** Header media typed in the resume dialog; saved with the broadcast. */
  headerMediaUrl?: string
}

interface SendContext {
  broadcastId: string
  accountId: string
  templateName: string
  templateLanguage: string
  template: MessageTemplate | undefined
  variables: Record<string, VariableMapping>
  messageParams: { headerMediaUrl: string } | undefined
  phoneNumberId: string
  accessToken: string
  /** audience_filter as written with our lease (kept in sync on renew). */
  audienceFilter: Record<string, unknown>
}

type RecipientRow = { id: string; contact: Contact | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function countRecipients(
  db: SupabaseClient,
  broadcastId: string,
  statuses: readonly string[],
): Promise<number> {
  const { count, error } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .in('status', [...statuses])
  if (error) throw new Error(`No se pudo contar los destinatarios: ${error.message}`)
  return count ?? 0
}

/** True while this process is sending `broadcastId`. */
export function isBroadcastRunning(broadcastId: string): boolean {
  return workerState().running.has(broadcastId)
}

/**
 * Validates, claims (lease) and launches the send of every 'pending'
 * recipient of the broadcast, scoped to `accountId`. Returns right
 * away; the send continues in the background.
 */
export async function startBroadcastSend(
  broadcastId: string,
  accountId: string,
  options: StartOptions = {},
): Promise<StartOutcome> {
  const st = workerState()
  // Check + add before any await: no two runs of the same broadcast.
  if (st.running.has(broadcastId)) return { kind: 'already_running' }
  st.running.add(broadcastId)
  let handedOff = false

  try {
    const db = supabaseAdmin()

    const { data: bc, error: bcErr } = await db
      .from('broadcasts')
      .select('id, account_id, status, template_name, template_language, template_variables, audience_filter')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (bcErr) return { kind: 'error', status: 500, message: `No se pudo cargar la difusión: ${bcErr.message}` }
    if (!bc) return { kind: 'error', status: 404, message: 'Difusión no encontrada' }

    const current = readLease(bc.audience_filter)
    if (leaseBlocks(current, st.owner, Date.now())) return { kind: 'already_running' }

    const pending = await countRecipients(db, broadcastId, ['pending'])
    if (pending === 0) {
      if (bc.status === 'sending') {
        const delivered = await countRecipients(db, broadcastId, DELIVERED_LIKE_STATUSES)
        await db
          .from('broadcasts')
          .update({ status: finalBroadcastStatus(delivered), audience_filter: withoutLease(bc.audience_filter) })
          .eq('id', broadcastId)
          .eq('account_id', accountId)
      }
      return { kind: 'nothing_pending' }
    }

    // WhatsApp config of the broadcast's account.
    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config?.phone_number_id || !config.access_token) {
      return { kind: 'error', status: 400, message: 'WhatsApp no está configurado para esta cuenta.' }
    }

    const templateName = bc.template_name as string
    const templateLanguage = (bc.template_language as string | null) ?? 'en_US'
    const { data: rawTemplate } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', templateLanguage)
      .maybeSingle()
    if (rawTemplate && !isMessageTemplate(rawTemplate)) {
      return {
        kind: 'error',
        status: 500,
        message: 'La plantilla está dañada localmente: usa "Sincronizar desde Meta" en Ajustes antes de enviar.',
      }
    }
    const template = (rawTemplate as MessageTemplate | null) ?? undefined

    // Media header: dialog URL, else the one saved with the broadcast,
    // else the template's. Meta rejects the send without it.
    const override = options.headerMediaUrl?.trim() || null
    let messageParams: { headerMediaUrl: string } | undefined
    let audienceFilter: Record<string, unknown> = withoutLease(bc.audience_filter)
    if (isMediaHeaderType(template?.header_type)) {
      const url = pickResumeHeaderMediaUrl(
        override,
        storedHeaderMediaUrl(bc.audience_filter),
        template?.header_media_url,
      )
      if (!url || headerMediaProblem(true, url)) {
        return {
          kind: 'error',
          status: 400,
          message:
            'La plantilla tiene una cabecera con imagen, video o documento y falta una URL válida. Ingrésala en el diálogo de reanudar.',
        }
      }
      messageParams = { headerMediaUrl: url }
      if (override) audienceFilter = { ...audienceFilter, headerMediaUrl: override }
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token as string)
    } catch {
      return { kind: 'error', status: 500, message: 'No se pudo leer el token de WhatsApp.' }
    }

    // Claim: compare-and-set on the lease we just read, so two
    // processes racing for the same broadcast cannot both win.
    const nowIso = new Date().toISOString()
    const lease: SendLease = { owner: st.owner, heartbeatAt: nowIso, startedAt: nowIso }
    const leasedFilter = withLease(audienceFilter, lease)
    let claim = db
      .from('broadcasts')
      .update({ status: 'sending', audience_filter: leasedFilter })
      .eq('id', broadcastId)
      .eq('account_id', accountId)
    claim = current
      ? claim.eq(`audience_filter->${LEASE_KEY}->>heartbeatAt`, current.heartbeatAt)
      : claim.is(`audience_filter->${LEASE_KEY}`, null)
    const { data: claimed, error: claimErr } = await claim.select('id')
    if (claimErr) return { kind: 'error', status: 500, message: `No se pudo iniciar el envío: ${claimErr.message}` }
    if (!claimed || claimed.length === 0) return { kind: 'already_running' }

    const ctx: SendContext = {
      broadcastId,
      accountId,
      templateName,
      templateLanguage,
      template,
      variables: (bc.template_variables ?? {}) as Record<string, VariableMapping>,
      messageParams,
      phoneNumberId: config.phone_number_id as string,
      accessToken,
      audienceFilter: leasedFilter,
    }

    handedOff = true
    void runSendLoop(db, ctx)
      .catch((err) => console.error(`[broadcast-worker] ${broadcastId} aborted:`, err))
      .finally(() => st.running.delete(broadcastId))
    return { kind: 'started', pending }
  } catch (err) {
    return { kind: 'error', status: 500, message: errText(err) }
  } finally {
    if (!handedOff) st.running.delete(broadcastId)
  }
}

async function updateRecipient(
  db: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // A row left 'pending' after a successful send would be sent again on
  // a later resume, so retry before giving up (and aborting the run).
  let lastErr: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await db.from('broadcast_recipients').update(patch).eq('id', id)
    if (!error) return
    lastErr = error.message
    await sleep(500 * (attempt + 1))
  }
  throw new Error(`No se pudo guardar el resultado del destinatario ${id}: ${lastErr}`)
}

async function fetchCustomValues(
  db: SupabaseClient,
  contactIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const index = new Map<string, Map<string, string>>()
  if (contactIds.length === 0) return index
  const { data, error } = await db
    .from('contact_custom_values')
    .select('contact_id, custom_field_id, value')
    .in('contact_id', contactIds)
  if (error) throw new Error(`No se pudieron cargar los campos personalizados: ${error.message}`)
  for (const row of (data ?? []) as { contact_id: string; custom_field_id: string; value: string | null }[]) {
    const bucket = index.get(row.contact_id) ?? new Map<string, string>()
    bucket.set(row.custom_field_id, row.value ?? '')
    index.set(row.contact_id, bucket)
  }
  return index
}

async function runSendLoop(db: SupabaseClient, ctx: SendContext): Promise<void> {
  const { broadcastId, accountId } = ctx
  const owner = workerState().owner
  let leaseLost = false

  // Heartbeat on its own timer: a slow Meta call does not let the
  // lease expire, and if this process dies the heartbeat stops with it.
  const renew = async () => {
    if (leaseLost) return
    const prev = readLease(ctx.audienceFilter)
    const next = withLease(ctx.audienceFilter, {
      owner,
      heartbeatAt: new Date().toISOString(),
      startedAt: prev?.startedAt ?? new Date().toISOString(),
    })
    const { data, error } = await db
      .from('broadcasts')
      .update({ audience_filter: next })
      .eq('id', broadcastId)
      .eq(`audience_filter->${LEASE_KEY}->>owner`, owner)
      .select('id')
    if (error) {
      console.warn(`[broadcast-worker] ${broadcastId} heartbeat failed:`, error.message)
      return
    }
    if (!data || data.length === 0) {
      leaseLost = true
      console.warn(`[broadcast-worker] ${broadcastId} lease lost, stopping`)
      return
    }
    ctx.audienceFilter = next
  }
  const timer = setInterval(() => {
    renew().catch((err) => console.warn('[broadcast-worker] heartbeat error:', err))
  }, LEASE_RENEW_MS)
  timer.unref?.()

  const attempted = new Set<string>()
  try {
    while (!leaseLost) {
      // Re-read 'pending' right before each batch: rows handled by
      // someone else meanwhile are not sent again.
      const { data, error } = await db
        .from('broadcast_recipients')
        .select('id, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .eq('status', 'pending')
        .order('id', { ascending: true })
        .limit(SERVER_BATCH_SIZE)
      if (error) throw new Error(`No se pudieron leer los pendientes: ${error.message}`)
      const pendingRows = (data ?? []) as unknown as RecipientRow[]
      const batch = selectBatch(pendingRows, attempted)
      if (batch.length === 0) {
        if (pendingRows.length > 0) {
          console.error(`[broadcast-worker] ${broadcastId} rows stay pending after an attempt; stopping`)
        }
        break
      }

      const contactIds = batch
        .map((r) => r.contact)
        .filter((c): c is Contact => Boolean(c && c.account_id === accountId))
        .map((c) => c.id)
      const customValues = await fetchCustomValues(db, contactIds)

      for (const r of batch) {
        if (leaseLost) break
        attempted.add(r.id)
        const contact = r.contact && r.contact.account_id === accountId ? r.contact : null
        if (!contact?.phone) {
          await updateRecipient(db, r.id, {
            status: 'failed',
            error_message: 'El contacto no tiene número de teléfono',
          })
          continue
        }

        const outcome = await sendTemplateToPhone({
          phoneNumberId: ctx.phoneNumberId,
          accessToken: ctx.accessToken,
          phone: contact.phone,
          templateName: ctx.templateName,
          language: ctx.templateLanguage,
          template: ctx.template,
          params: resolveVariables(ctx.variables, contact, customValues.get(contact.id)),
          messageParams: ctx.messageParams,
        })

        if (outcome.status === 'sent') {
          await updateRecipient(db, r.id, {
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: outcome.messageId,
            error_message: null,
          })
        } else {
          await updateRecipient(db, r.id, { status: 'failed', error_message: outcome.error })
        }
      }

      await sleep(SERVER_BATCH_PAUSE_MS)
    }
  } finally {
    clearInterval(timer)
    // Lease lost: the new owner finalizes. Otherwise close the run and
    // free the lease (still-pending rows, if any, can be resumed).
    if (!leaseLost) {
      try {
        const delivered = await countRecipients(db, broadcastId, DELIVERED_LIKE_STATUSES)
        await db
          .from('broadcasts')
          .update({
            status: finalBroadcastStatus(delivered),
            audience_filter: withoutLease(ctx.audienceFilter),
          })
          .eq('id', broadcastId)
          .eq(`audience_filter->${LEASE_KEY}->>owner`, owner)
      } catch (err) {
        console.error(`[broadcast-worker] ${broadcastId} finalize failed:`, err)
      }
    }
  }
}

/**
 * Sweeper (called every minute by the in-process scheduler and at
 * boot): retakes broadcasts left in 'sending' with a lease whose
 * heartbeat expired, i.e. their worker died (restart, deploy, crash).
 * Broadcasts without a lease (old browser-loop sends) are not touched:
 * those are resumed by hand with "Reanudar envío".
 */
export async function resumeOrphanedBroadcasts(): Promise<{ checked: number; started: number }> {
  const db = supabaseAdmin()
  const st = workerState()
  const { data, error } = await db
    .from('broadcasts')
    .select('id, account_id, audience_filter')
    .eq('status', 'sending')
    .not(`audience_filter->${LEASE_KEY}`, 'is', null)
    .limit(50)
  if (error) throw new Error(error.message)

  let started = 0
  const now = Date.now()
  for (const bc of (data ?? []) as { id: string; account_id: string; audience_filter: unknown }[]) {
    if (st.running.has(bc.id) || leaseBlocks(readLease(bc.audience_filter), st.owner, now)) continue
    const res = await startBroadcastSend(bc.id, bc.account_id)
    if (res.kind === 'started') started++
    else if (res.kind === 'error') {
      console.error(`[broadcast-worker] could not resume ${bc.id}:`, res.message)
      // Permanent problem (config, template, media): drop the lease and
      // close the status so the sweeper does not retry every minute.
      // The pending rows stay visible for "Reanudar envío".
      if (res.status < 500) {
        try {
          const delivered = await countRecipients(db, bc.id, DELIVERED_LIKE_STATUSES)
          await db
            .from('broadcasts')
            .update({ status: finalBroadcastStatus(delivered), audience_filter: withoutLease(bc.audience_filter) })
            .eq('id', bc.id)
            .eq('status', 'sending')
        } catch (err) {
          console.error(`[broadcast-worker] could not release ${bc.id}:`, err)
        }
      }
    }
  }
  return { checked: data?.length ?? 0, started }
}
