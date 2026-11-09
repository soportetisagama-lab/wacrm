import { createHash } from 'node:crypto';

/**
 * Deterministic event_id for (account, contact, dedup key): the same
 * signal always carries the same id, so even a retry that reaches Meta
 * twice is deduplicated on Meta's side too. Server-only (node:crypto).
 */
export function buildEventId(accountId: string, contactId: string, dedupKey: string): string {
  return createHash('sha256').update(`${accountId}:${contactId}:${dedupKey}`).digest('hex').slice(0, 40);
}
