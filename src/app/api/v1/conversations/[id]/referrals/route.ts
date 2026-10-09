import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

/** A transfer carries a handful at most; this just bounds a bad payload. */
const MAX_REFERRALS = 20;

const TEXT_FIELDS = [
  'source_id',
  'source_url',
  'headline',
  'body',
  'media_type',
  'image_url',
  'video_url',
  'ctwa_clid',
] as const;

/**
 * POST /api/v1/conversations/{id}/referrals — attach Click-to-WhatsApp
 * ad referrals to a conversation. Scope: `contacts:write`.
 * Body: `{ "referrals": [{ source_id, source_url, headline, body,
 * media_type, image_url, video_url, ctwa_clid, created_at }] }`.
 *
 * Used by the cross-line transfer ("Derivar a otra línea"): the source
 * line forwards the ad the customer came in through, so the receiving
 * line's "Origen del anuncio" card shows the same ad and ad id.
 * `created_at` keeps the original click time when it's a valid date.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { referrals?: unknown };
    if (!Array.isArray(body.referrals) || body.referrals.length === 0) {
      return fail('bad_request', '`referrals` must be a non-empty array', 400);
    }

    const { data: conversation, error: convError } = await ctx.supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (convError) return fail('internal', convError.message, 500);
    if (!conversation) return fail('not_found', 'Conversation not found', 404);

    type ReferralRow = Record<(typeof TEXT_FIELDS)[number], string | null> & {
      account_id: string;
      conversation_id: string;
      contact_id: string;
      created_at: string;
    };
    const rows = body.referrals.slice(0, MAX_REFERRALS).flatMap((raw): ReferralRow[] => {
      if (!raw || typeof raw !== 'object') return [];
      const r = raw as Record<string, unknown>;
      const row = {} as Record<(typeof TEXT_FIELDS)[number], string | null>;
      for (const field of TEXT_FIELDS) {
        row[field] = typeof r[field] === 'string' && r[field] ? (r[field] as string) : null;
      }
      if (!row.source_id && !row.headline && !row.source_url) return [];
      const createdAt =
        typeof r.created_at === 'string' && !Number.isNaN(Date.parse(r.created_at))
          ? r.created_at
          : new Date().toISOString();
      return [
        {
          ...row,
          account_id: ctx.accountId,
          conversation_id: conversation.id as string,
          contact_id: conversation.contact_id as string,
          created_at: createdAt,
        },
      ];
    });
    if (rows.length === 0) return fail('bad_request', 'No valid referrals', 400);

    // Skip ads already on this conversation (a second transfer of the
    // same customer would otherwise duplicate the card).
    const ids = rows.map((r) => r.source_id).filter((v): v is string => !!v);
    let fresh = rows;
    if (ids.length > 0) {
      const { data: existing } = await ctx.supabase
        .from('conversation_referrals')
        .select('source_id')
        .eq('conversation_id', conversation.id)
        .in('source_id', ids);
      const seen = new Set((existing ?? []).map((e) => e.source_id as string));
      fresh = rows.filter((r) => !r.source_id || !seen.has(r.source_id));
    }
    if (fresh.length === 0) return ok({ inserted: 0 }, 200);

    const { error } = await ctx.supabase.from('conversation_referrals').insert(fresh);
    if (error) return fail('internal', error.message, 500);
    return ok({ inserted: fresh.length }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
