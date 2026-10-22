import type { SupabaseClient } from '@supabase/supabase-js';

import { canRemoveEstadoTags, type AccountRole } from '@/lib/auth/roles';
import { isEstadoTag } from '@/lib/xlr8/estados';

export class ContactTagWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ContactTagWriteError';
    this.status = status;
  }
}

interface ContactTagWriteInput {
  accountId: string;
  contactId: string;
  tagId: string;
}

async function assertContactAndTagOwnership(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<{ name?: string; is_shared?: boolean | null }> {
  const [contactResult, tagResult] = await Promise.all([
    db
      .from('contacts')
      .select('id')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
    db
      .from('tags')
      .select('id, name, is_shared')
      .eq('id', input.tagId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
  ]);

  if (contactResult.error || tagResult.error) {
    throw new ContactTagWriteError('Could not verify contact tag ownership');
  }
  if (!contactResult.data) {
    throw new ContactTagWriteError('Contact not found', 404);
  }
  if (!tagResult.data) {
    throw new ContactTagWriteError('Tag not found', 404);
  }
  return tagResult.data as { name?: string; is_shared?: boolean | null };
}

/**
 * Add a tag exactly once. The unique constraint on
 * (contact_id, tag_id) is the concurrency-safe source of truth: a
 * duplicate insert is a no-op and must not emit a tag_added event.
 */
export async function addContactTagIfAbsent(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  const { error } = await db
    .from('contact_tags')
    .insert({ contact_id: input.contactId, tag_id: input.tagId })
    .select('id')
    .maybeSingle();

  if (error?.code === '23505') return false;
  if (error) {
    throw new ContactTagWriteError(
      `Failed to add contact tag: ${error.message}`
    );
  }
  return true;
}

/**
 * Remove a tag from a contact. `actorRole` is the role of the person
 * asking (API routes pass it): without admin/owner, xlr8 status tags
 * can't be removed. System callers (flows) omit it.
 */
export async function removeContactTag(
  db: SupabaseClient,
  input: ContactTagWriteInput,
  actorRole?: AccountRole
): Promise<void> {
  const tag = await assertContactAndTagOwnership(db, input);

  if (
    actorRole &&
    !canRemoveEstadoTags(actorRole) &&
    typeof tag.name === 'string' &&
    isEstadoTag({ name: tag.name, is_shared: tag.is_shared })
  ) {
    throw new ContactTagWriteError(
      'Solo un administrador puede quitar etiquetas de estado.',
      403
    );
  }

  const { error } = await db
    .from('contact_tags')
    .delete()
    .eq('contact_id', input.contactId)
    .eq('tag_id', input.tagId);

  if (error) {
    throw new ContactTagWriteError(
      `Failed to remove contact tag: ${error.message}`
    );
  }
}
