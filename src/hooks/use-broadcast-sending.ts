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
  isMediaHeaderType,
  pickResumeHeaderMediaUrl,
  sendPhaseProgress,
  storedHeaderMediaUrl,
} from '@/lib/broadcasts/send-loop';
import type { VariableMapping } from '@/lib/broadcasts/variables';

export type { VariableMapping } from '@/lib/broadcasts/variables';

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

/** Live counters of a send, for the progress panel. */
export interface BroadcastSendStats {
  total: number;
  sent: number;
  failed: number;
  /** Epoch ms when the pace measurement started (null before). */
  startedAt: number | null;
  /** sent + failed already done at `startedAt` (pace counts only what came after). */
  baseline?: number;
}

export const EMPTY_SEND_STATS: BroadcastSendStats = { total: 0, sent: 0, failed: 0, startedAt: null };

export interface ResumeOptions {
  /** Header media typed in the resume dialog (wins over stored URLs). */
  headerMediaUrl?: string;
}

/** What the resume dialog needs to know about the header media. */
export interface ResumeMediaInfo {
  /** image / video / document, or null for text / no header. */
  mediaHeaderType: MessageTemplate['header_type'] | null;
  /** URL resume would use without asking (broadcast first, then template). */
  knownUrl: string | null;
}

async function fetchTemplateHeader(
  supabase: ReturnType<typeof createClient>,
  name: string,
  language: string,
): Promise<Pick<MessageTemplate, 'header_type' | 'header_media_url'> | null> {
  const { data } = await supabase
    .from('message_templates')
    .select('header_type, header_media_url')
    .eq('name', name)
    .eq('language', language)
    .limit(1)
    .maybeSingle();
  return (data as Pick<MessageTemplate, 'header_type' | 'header_media_url'> | null) ?? null;
}

/**
 * For the resume dialog: whether the template header is media and which
 * URL is already known. `knownUrl` null on a media header means the
 * dialog must ask for it.
 */
export async function fetchResumeMediaInfo(broadcast: {
  template_name: string;
  template_language: string | null;
  audience_filter?: unknown;
}): Promise<ResumeMediaInfo> {
  const template = await fetchTemplateHeader(
    createClient(),
    broadcast.template_name,
    broadcast.template_language ?? 'en_US',
  );
  if (!isMediaHeaderType(template?.header_type)) {
    return { mediaHeaderType: null, knownUrl: null };
  }
  return {
    mediaHeaderType: template!.header_type ?? null,
    knownUrl: pickResumeHeaderMediaUrl(
      null,
      storedHeaderMediaUrl(broadcast.audience_filter),
      template?.header_media_url,
    ),
  };
}

/** Outcome of POST /api/broadcasts/[id]/start. */
export type StartResult =
  | { kind: 'started'; pending: number }
  | { kind: 'already_running' }
  | { kind: 'nothing_pending' };

export interface CreateResult {
  broadcastId: string;
  /** Set when the broadcast was created but the server send could not start. */
  startError?: string;
}

interface UseBroadcastSendingReturn {
  /** Creates the broadcast + 'pending' recipients, then starts the server send. */
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<CreateResult>;
  /** Asks the server to send the recipients still 'pending'. */
  resumeBroadcast: (broadcastId: string, options?: ResumeOptions) => Promise<StartResult>;
  isProcessing: boolean;
  /** Progress of the preparation (audience + recipient rows) in this tab. */
  progress: number;
}

/** `broadcast_recipients` inserts per request. */
const INSERT_BATCH_SIZE = 200;

/**
 * Starts (or resumes) the send on the server. It keeps going even if
 * this tab is closed; progress is read back from the database.
 */
export async function startBroadcastOnServer(
  broadcastId: string,
  options: ResumeOptions = {},
): Promise<StartResult> {
  const res = await fetch(`/api/broadcasts/${encodeURIComponent(broadcastId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options.headerMediaUrl ? { headerMediaUrl: options.headerMediaUrl } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as {
    started?: boolean;
    pending?: number;
    code?: string;
    error?: string;
  };
  if (res.status === 409 && data.code === 'already_running') return { kind: 'already_running' };
  if (!res.ok) throw new Error(data.error || `Error ${res.status} al iniciar el envío`);
  return data.started ? { kind: 'started', pending: data.pending ?? 0 } : { kind: 'nothing_pending' };
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

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

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

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<CreateResult> {
    setIsProcessing(true);
    setProgress(0);

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
            // No dedicated column: the server worker reads the header
            // media from here (also on "Resume sending").
            ...(isMediaHeaderType(payload.template.header_type) &&
            payload.headerMediaUrl?.trim()
              ? { headerMediaUrl: payload.headerMediaUrl.trim() }
              : {}),
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
        setProgress(sendPhaseProgress(20, 70, i + batch.length, recipientRows.length));
      }

      // ── Step 4: Hand the send to the server ───────────────────────
      // Template, language, variables and header media are on the row;
      // the server worker sends from there, even if this tab closes.
      setProgress(90);
      let startError: string | undefined;
      try {
        await startBroadcastOnServer(broadcast.id);
      } catch (err) {
        startError = errText(err);
      }

      setProgress(100);
      return { broadcastId: broadcast.id, startError };
    } finally {
      setIsProcessing(false);
    }
  }

  async function resumeBroadcast(
    broadcastId: string,
    options: ResumeOptions = {},
  ): Promise<StartResult> {
    setIsProcessing(true);
    try {
      return await startBroadcastOnServer(broadcastId, options);
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, resumeBroadcast, isProcessing, progress };
}
