import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Receiving side of "Derivar a otra línea" (sending side:
 * src/lib/line-transfer.ts). A conversation counts as transferred in
 * when this line sent it the transfer template recently. For those:
 *  - the welcome-menu Flows stay out of it (the customer already said
 *    what they need on the other line), and
 *  - the AI assistant answers with the handover note — topic + the
 *    source chat's history, left on the contact by the transfer — in
 *    its instructions.
 * Detected from existing rows (the template message + the contact
 * note), so no schema change.
 */

/** Must match the `template` the other lines send (LINE_TRANSFER_CONFIG). */
const TRANSFER_TEMPLATE = process.env.LINE_TRANSFER_TEMPLATE || "derivacion_linea";
/** After this, the customer is treated like any returning one again. */
const TRANSFER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Prefix of the note written by buildTransferNote. */
const TRANSFER_NOTE_PREFIX = "🔀 Derivado desde";
const FALLBACK_NOTE = "🔀 Derivado desde otra línea de Sagama.";

/** Best-effort: a failed lookup counts as "not transferred" — never blocks a reply. */
export async function isRecentLineTransfer(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - TRANSFER_WINDOW_MS).toISOString();
    const { data, error } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("template_name", TRANSFER_TEMPLATE)
      .gte("created_at", since)
      .limit(1);
    if (error) throw error;
    return (data ?? []).length > 0;
  } catch (err) {
    console.error("[line-transfer] transfer lookup failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** The handover note for a recently transferred-in conversation, or null. */
export async function loadLineTransferContext(
  db: SupabaseClient,
  conversationId: string,
  contactId: string,
): Promise<string | null> {
  if (!(await isRecentLineTransfer(db, conversationId))) return null;
  try {
    const { data } = await db
      .from("contact_notes")
      .select("note_text")
      .eq("contact_id", contactId)
      .like("note_text", `${TRANSFER_NOTE_PREFIX}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.note_text as string | undefined) ?? FALLBACK_NOTE;
  } catch {
    return FALLBACK_NOTE;
  }
}
