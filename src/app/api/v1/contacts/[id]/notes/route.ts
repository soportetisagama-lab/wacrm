import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getContactById, resolveAuditUserId } from '@/lib/api/v1/contacts';

/** contact_notes has no length cap; this keeps a pasted transcript sane. */
const MAX_NOTE_LENGTH = 20000;

/**
 * POST /api/v1/contacts/{id}/notes — add a note to a contact.
 * Scope: `contacts:write`. Body: `{ "text": "…" }`.
 *
 * Used by the cross-line transfer ("Derivar a otra línea") to hand the
 * receiving line the handover context and the source chat's history.
 * Notes are authored as the key's creator, falling back to the account
 * owner (same audit rule as the other v1 writes).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return fail('bad_request', '`text` is required', 400);

    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    if (!contact) return fail('not_found', 'Contact not found', 404);

    const userId = ctx.createdBy ?? (await resolveAuditUserId(ctx.supabase, ctx.accountId));
    const { data, error } = await ctx.supabase
      .from('contact_notes')
      .insert({
        contact_id: id,
        account_id: ctx.accountId,
        user_id: userId,
        note_text: text.slice(0, MAX_NOTE_LENGTH),
      })
      .select('id, note_text, created_at')
      .single();
    if (error) return fail('internal', error.message, 500);
    return ok(data, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
