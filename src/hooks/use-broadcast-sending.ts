'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Contact, MessageTemplate } from '@/types';
import {
  ID_CHUNK,
  chunk,
  fetchAllPages,
  fetchCustomFieldContactIds,
  fetchTaggedContactIds,
} from '@/lib/broadcasts/audience';
import {
  DELIVERED_LIKE_STATUSES,
  filterStillPending,
  isMediaHeaderType,
  loopCounters,
  resumeFinalStatus,
  sendPhaseProgress,
} from '@/lib/broadcasts/send-loop';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
}

/** Live counters of the send loop, for the progress panel. */
export interface BroadcastSendStats {
  total: number;
  sent: number;
  failed: number;
  /** Epoch ms when the send loop started (null before it starts). */
  startedAt: number | null;
}

export const EMPTY_SEND_STATS: BroadcastSendStats = { total: 0, sent: 0, failed: 0, startedAt: null };

export interface ResumeResult {
  attempted: number;
  sent: number;
  failed: number;
  /** Recipients another tab handled meanwhile. */
  skipped: number;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  /**
   * Sends only the recipients still 'pending' of an existing broadcast
   * (e.g. the original tab was closed mid-send).
   */
  resumeBroadcast: (broadcastId: string) => Promise<ResumeResult>;
  isProcessing: boolean;
  progress: number;
  stats: BroadcastSendStats;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** Retries of a batch the server rejected with 429 (rate limit). */
const RATE_LIMIT_RETRIES = 5;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | null | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // Chunk the id list (URL length) and page each chunk (1000-row cap:
  // a contact can have several custom values).
  for (const slice of chunk(contactIds, ID_CHUNK)) {
    const rows = await fetchAllPages<{ contact_id: string; custom_field_id: string; value: string | null }>(
      (from, to) =>
        supabase
          .from('contact_custom_values')
          .select('contact_id, custom_field_id, value')
          .in('contact_id', slice)
          .order('id', { ascending: true })
          .range(from, to),
    );

    for (const row of rows) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Full contact rows for `ids`, in chunks small enough for the URL. */
async function fetchContactsByIds(
  supabase: ReturnType<typeof createClient>,
  ids: string[],
): Promise<Contact[]> {
  const out: Contact[] = [];
  for (const slice of chunk(ids, ID_CHUNK)) {
    const { data, error } = await supabase.from('contacts').select('*').in('id', slice);
    if (error) throw new Error(`No se pudieron cargar los contactos: ${error.message}`);
    out.push(...((data ?? []) as Contact[]));
  }
  return out;
}

type SupabaseBrowser = ReturnType<typeof createClient>;

/** A broadcast_recipients row with its joined contact. */
type SendRecipient = { id: string; contact: Contact | null };

interface SendLoopOptions {
  templateName: string;
  templateLanguage: string;
  variables: Record<string, VariableMapping>;
  customValueIndex: CustomValueIndex;
  messageParams?: { headerMediaUrl: string };
  /**
   * How to react when the pre-batch status re-check fails. `true`
   * (resume) aborts the loop so nobody gets the message twice; `false`
   * (fresh broadcast) sends the batch unfiltered, as before.
   */
  strictPendingCheck: boolean;
  /** Cumulative counters after each batch (processed includes skipped). */
  onBatchDone: (c: { processed: number; failed: number; skipped: number }) => void;
}

/**
 * Current status of `ids`. Throws on a query error so the caller
 * decides between fail-open and fail-closed.
 */
async function fetchRecipientStatuses(
  supabase: SupabaseBrowser,
  ids: string[],
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('broadcast_recipients')
    .select('id, status')
    .in('id', ids);
  if (error) throw new Error(`No se pudo verificar el estado de los destinatarios: ${error.message}`);
  return new Map(((data ?? []) as { id: string; status: string }[]).map((r) => [r.id, r.status]));
}

/**
 * Sends `recipients` in batches of SEND_BATCH_SIZE with a pause between
 * batches, retrying 429s, and writes each recipient's outcome. Right
 * before each batch it re-reads the rows and skips those no longer
 * 'pending' (another tab already sent them), so two tabs working on
 * the same broadcast do not message a contact twice.
 */
async function runSendLoop(
  supabase: SupabaseBrowser,
  recipients: SendRecipient[],
  opts: SendLoopOptions,
): Promise<{ failedCount: number; skippedCount: number }> {
  let failedCount = 0;
  let skippedCount = 0;
  const { messageParams } = opts;

  for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
    const fullBatch = recipients.slice(i, i + SEND_BATCH_SIZE);

    let batch = fullBatch;
    try {
      const statuses = await fetchRecipientStatuses(
        supabase,
        fullBatch.map((r) => r.id),
      );
      batch = filterStillPending(fullBatch, statuses);
    } catch (err) {
      if (opts.strictPendingCheck) throw err;
      console.warn('[broadcasts] pending re-check failed, sending batch as is:', err);
    }
    skippedCount += fullBatch.length - batch.length;

    const apiRecipients = batch
      .filter((r) => r.contact?.phone)
      .map((r) => ({
        phone: r.contact!.phone as string,
        params: r.contact
          ? resolveVariables(
              opts.variables,
              r.contact,
              opts.customValueIndex.get(r.contact.id),
            )
          : [],
        ...(messageParams ? { messageParams } : {}),
      }));

    try {
      // A batch with no phone numbers skips the API call; the loop
      // below marks each of those recipients failed (no result).
      let apiResults: BroadcastApiResult[] = [];
      if (apiRecipients.length > 0) {
        const body = JSON.stringify({
          recipients: apiRecipients,
          template_name: opts.templateName,
          template_language: opts.templateLanguage,
        });
        let res: Response;
        let data: { error?: string; results?: unknown; retry_after_seconds?: number };
        // A 429 means "too fast", not a bad batch: wait what the
        // server asks and resend the same batch instead of failing it.
        for (let attempt = 0; ; attempt++) {
          res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          data = await res.json();
          if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
          const waitSec = Math.min(Math.max(Number(data.retry_after_seconds) || 5, 1), 60);
          await sleep(waitSec * 1000 + 250);
        }

        if (!res.ok) {
          throw new Error(data.error || 'Falló el envío de la difusión');
        }
        apiResults = (data.results ?? []) as BroadcastApiResult[];
      }

      const resultsByPhone = new Map<string, BroadcastApiResult>();
      for (const r of apiResults) {
        resultsByPhone.set(r.phone, r);
      }

      for (const recipient of batch) {
        const phone = recipient.contact?.phone;
        const result = phone ? resultsByPhone.get(phone) : undefined;

        if (!result) {
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: 'El contacto no tiene número de teléfono',
            })
            .eq('id', recipient.id);
          continue;
        }

        if (result.status === 'sent') {
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              whatsapp_message_id: result.whatsapp_message_id ?? null,
              error_message: null,
            })
            .eq('id', recipient.id);
        } else {
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: result.error ?? 'Error desconocido',
            })
            .eq('id', recipient.id);
        }
      }
    } catch (err) {
      for (const recipient of batch) {
        failedCount++;
        await supabase
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: err instanceof Error ? err.message : 'Error desconocido',
          })
          .eq('id', recipient.id);
      }
    }

    opts.onBatchDone({
      processed: Math.min(i + fullBatch.length, recipients.length),
      failed: failedCount,
      skipped: skippedCount,
    });

    if (i + SEND_BATCH_SIZE < recipients.length) {
      await sleep(SEND_BATCH_DELAY_MS);
    }
  }

  return { failedCount, skippedCount };
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stats, setStats] = useState<BroadcastSendStats>(EMPTY_SEND_STATS);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      try {
        contacts = await fetchAllPages<Contact>((from, to) =>
          supabase.from('contacts').select('*').order('id', { ascending: true }).range(from, to),
        );
      } catch (err) {
        throw new Error(`No se pudieron cargar los contactos: ${errText(err)}`);
      }
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      let taggedIds: Set<string>;
      try {
        taggedIds = await fetchTaggedContactIds(supabase, audience.tagIds);
      } catch (err) {
        throw new Error(`No se pudieron cargar las etiquetas de los contactos: ${errText(err)}`);
      }
      contacts = await fetchContactsByIds(supabase, [...taggedIds]);
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(supabase, audience.customField);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(supabase, audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      let excludedIds: Set<string>;
      try {
        excludedIds = await fetchTaggedContactIds(supabase, audience.excludeTagIds);
      } catch (err) {
        // Sending to contacts that should be excluded is worse than not
        // sending at all — abort instead of ignoring the error.
        throw new Error(`No se pudieron cargar las etiquetas a excluir: ${errText(err)}`);
      }
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: { phone: string; name?: string }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('No has iniciado sesión.');
    }
    if (!accountId) {
      throw new Error('Tu perfil no está vinculado a ninguna cuenta.');
    }

    // De-duplicate by phone within the CSV (users can paste duplicates).
    const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      if (row.phone) uniqueByPhone.set(row.phone, row);
    }
    const phones = [...uniqueByPhone.keys()];

    // Look up existing contacts by phone, chunked (URL length).
    const byPhone = new Map<string, Contact>();
    for (const slice of chunk(phones, ID_CHUNK)) {
      const { data: existing, error: lookupErr } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', user.id)
        .in('phone', slice);
      if (lookupErr) {
        throw new Error(`No se pudieron buscar los contactos del CSV: ${lookupErr.message}`);
      }
      for (const c of (existing ?? []) as Contact[]) {
        if (c.phone) byPhone.set(c.phone, c);
      }
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = phones
      .filter((p) => !byPhone.has(p))
      .map((phone) => ({
        user_id: user.id,
        account_id: accountId,
        phone,
        name: uniqueByPhone.get(phone)?.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`No se pudieron crear los contactos del CSV: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        if (c.phone) byPhone.set(c.phone, c);
      }
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return phones
      .map((p) => byPhone.get(p))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    // eq/neq/ilike per operator ("contains" is case-insensitive), paged.
    let contactIds: Set<string>;
    try {
      contactIds = await fetchCustomFieldContactIds(supabase, filter);
    } catch (err) {
      throw new Error(`Falló el filtro por campo personalizado: ${errText(err)}`);
    }
    if (contactIds.size === 0) return [];
    return fetchContactsByIds(supabase, [...contactIds]);
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);
    setStats(EMPTY_SEND_STATS);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('No has iniciado sesión.');
      }
      if (!accountId) {
        throw new Error('Tu perfil no está vinculado a ninguna cuenta.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No se encontraron contactos para esta audiencia.');
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `No se pudo crear la difusión: ${broadcastError?.message ?? 'error desconocido'}`,
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      setProgress(20);
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `No se pudo guardar el lote de destinatarios ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`,
          );
        }
      }

      // ── Step 4: Fetch recipients (joined contact) + preload custom values
      setProgress(30);
      type RecipientRow = { id: string; contact: Contact | null };
      let recipients: RecipientRow[];
      try {
        recipients = await fetchAllPages<RecipientRow>((from, to) =>
          supabase
            .from('broadcast_recipients')
            .select('*, contact:contacts(*)')
            .eq('broadcast_id', broadcast.id)
            .order('id', { ascending: true })
            .range(from, to),
        );
      } catch {
        throw new Error('No se pudieron cargar los destinatarios de la difusión.');
      }

      // One bulk fetch of custom values for every contact in this
      // broadcast, avoiding N+1 during the send loop.
      const contactIds = recipients
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id));
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contactIds,
      );

      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted.
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeaderType(payload.template.header_type) && headerMediaUrl
          ? { headerMediaUrl }
          : undefined;

      const totalRecipients = recipients.length;
      setStats({ total: totalRecipients, sent: 0, failed: 0, startedAt: Date.now() });

      const { failedCount, skippedCount } = await runSendLoop(supabase, recipients, {
        templateName: payload.template.name,
        templateLanguage: payload.template.language ?? 'en_US',
        variables: payload.variables,
        customValueIndex,
        messageParams,
        // Fail-open: a failed re-check must not stop a fresh broadcast.
        strictPendingCheck: false,
        onBatchDone: ({ processed, failed, skipped }) => {
          setProgress(sendPhaseProgress(30, 60, processed, totalRecipients));
          setStats((s) => ({ ...s, ...loopCounters(totalRecipients, processed, failed, skipped) }));
        },
      });

      // ── Step 5: Finalize status ───────────────────────────────────
      // Aggregate counts are maintained by the DB trigger (migration
      // 003); we only flip the final status here.
      setProgress(95);
      // Same rule as before (all failed -> 'failed'); recipients skipped
      // because another tab sent them do not count as failures.
      const finalStatus =
        failedCount === totalRecipients - skippedCount &&
        (skippedCount === 0 || failedCount > 0)
          ? 'failed'
          : 'sent';
      await supabase
        .from('broadcasts')
        .update({ status: finalStatus })
        .eq('id', broadcast.id);

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  async function resumeBroadcast(broadcastId: string): Promise<ResumeResult> {
    setIsProcessing(true);
    setProgress(0);
    setStats(EMPTY_SEND_STATS);

    const supabase = createClient();
    let markedSending = false;

    try {
      // ── Step 1: Broadcast row + template ──────────────────────────
      const { data: bc, error: bcErr } = await supabase
        .from('broadcasts')
        .select('id, template_name, template_language, template_variables')
        .eq('id', broadcastId)
        .single();
      if (bcErr || !bc) {
        throw new Error(`No se pudo cargar la difusión: ${bcErr?.message ?? 'no encontrada'}`);
      }
      const templateName = bc.template_name as string;
      const templateLanguage = (bc.template_language as string | null) ?? 'en_US';
      const variables = (bc.template_variables ?? {}) as Record<string, VariableMapping>;

      // Only needed to know whether the header is media. No media URL
      // was stored with the broadcast, so none is sent: the server falls
      // back to the URL saved on the template.
      const { data: tpl } = await supabase
        .from('message_templates')
        .select('header_type, header_media_url')
        .eq('name', templateName)
        .eq('language', templateLanguage)
        .limit(1)
        .maybeSingle();
      const template = tpl as Pick<MessageTemplate, 'header_type' | 'header_media_url'> | null;
      if (isMediaHeaderType(template?.header_type) && !template?.header_media_url) {
        throw new Error(
          'La plantilla tiene una cabecera con imagen, video o documento, pero no tiene la URL guardada. Sincroniza la plantilla antes de reanudar.',
        );
      }

      // ── Step 2: Pending recipients + custom values ────────────────
      setProgress(5);
      let recipients: SendRecipient[];
      try {
        recipients = await fetchAllPages<SendRecipient>((from, to) =>
          supabase
            .from('broadcast_recipients')
            .select('*, contact:contacts(*)')
            .eq('broadcast_id', broadcastId)
            .eq('status', 'pending')
            .order('id', { ascending: true })
            .range(from, to),
        );
      } catch {
        throw new Error('No se pudieron cargar los destinatarios pendientes.');
      }
      if (recipients.length === 0) {
        setProgress(100);
        return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
      }

      const contactIds = recipients
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id));
      const customValueIndex = await fetchCustomValueIndex(supabase, contactIds);

      // ── Step 3: Send ──────────────────────────────────────────────
      setProgress(10);
      const { error: upErr } = await supabase
        .from('broadcasts')
        .update({ status: 'sending' })
        .eq('id', broadcastId);
      if (upErr) throw new Error(`No se pudo marcar la difusión como en envío: ${upErr.message}`);
      markedSending = true;

      const totalRecipients = recipients.length;
      setStats({ total: totalRecipients, sent: 0, failed: 0, startedAt: Date.now() });

      const { failedCount, skippedCount } = await runSendLoop(supabase, recipients, {
        templateName,
        templateLanguage,
        variables,
        customValueIndex,
        // Fail-closed: if we cannot confirm a row is still pending, stop
        // rather than risk messaging the contact twice.
        strictPendingCheck: true,
        onBatchDone: ({ processed, failed, skipped }) => {
          setProgress(sendPhaseProgress(10, 85, processed, totalRecipients));
          setStats((s) => ({ ...s, ...loopCounters(totalRecipients, processed, failed, skipped) }));
        },
      });

      const attempted = totalRecipients - skippedCount;
      return {
        attempted,
        sent: attempted - failedCount,
        failed: failedCount,
        skipped: skippedCount,
      };
    } finally {
      // ── Step 4: Finalize status ───────────────────────────────────
      // Judged on the whole broadcast: 'failed' only if nobody got it.
      // Runs on abort too, so the row does not stay stuck in 'sending'
      // (still-pending recipients can be resumed again).
      if (markedSending) {
        setProgress(95);
        const { count, error: countErr } = await supabase
          .from('broadcast_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('broadcast_id', broadcastId)
          .in('status', [...DELIVERED_LIKE_STATUSES]);
        if (!countErr) {
          await supabase
            .from('broadcasts')
            .update({ status: resumeFinalStatus(count ?? 0) })
            .eq('id', broadcastId);
        }
        setProgress(100);
      }
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, resumeBroadcast, isProcessing, progress, stats };
}
