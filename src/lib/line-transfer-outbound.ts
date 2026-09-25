import type { SupabaseClient } from "@supabase/supabase-js";

import { engineSendText } from "@/lib/flows/meta-send";
import { TRANSFER_NOTICE_PREFIX } from "@/lib/line-transfer";

/**
 * Source side of "Derivar a otra línea", AFTER the transfer: the chat the
 * customer was transferred OUT of (receiving side: line-transfer-inbound.ts).
 *
 * Without this, anything the customer sent next — "ok gracias", a
 * sticker — restarted the welcome menu, right after being told another
 * line is handling them. For TRANSFER_WINDOW_MS after the transfer
 * notice, and while no human owns the chat:
 *  - an acknowledgement (thanks/ok/emoji/sticker) gets a fixed farewell,
 *    at most MAX_FAREWELLS times, then silence;
 *  - anything else skips the menu and goes to the AI assistant, which
 *    gets the transfer note as context (loadOutboundTransferContext).
 * Detected from existing rows (the notice + the contact note), no schema
 * change.
 */

const TRANSFER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAREWELLS = 2;
/** Prefix of the source-side note written by the transfer route. */
const OUTBOUND_NOTE_PREFIX = "🔀 Derivado a";

export const TRANSFER_FAREWELL_TEXT =
  "¡Gracias a usted! 😊 Si necesita algo más, escríbanos por este medio y con gusto le ayudamos. ¡Que tenga un excelente día!";

/** Words that, on their own, only thank / acknowledge / say goodbye. */
const ACK_WORDS = new Set([
  "ok", "okay", "oka", "oki", "okey", "okis", "ya", "listo", "gracias", "gracia",
  "grx", "grax", "muchas", "muchisimas", "mil", "perfecto", "bueno", "buenisimo",
  "dale", "entendido", "entiendo", "genial", "excelente", "vale", "super", "bien",
  "esta", "igualmente", "chau", "chao", "adios", "bye", "saludos", "de", "nada",
  "a", "usted", "ti", "le", "te", "lo", "agradezco", "si", "claro", "thanks",
  "thank", "you", "muy", "amable", "tan", "buen", "dia", "tarde", "noche",
  "buenas", "buenos", "hasta", "luego", "pronto", "cuidese", "cuidate",
]);

/**
 * True for messages that only thank, acknowledge or say goodbye:
 * "ok gracias", "Muchas gracias!!", "👍", a sticker. Anything carrying a
 * request ("también quiero góndolas", a number) is not one.
 */
export function isAcknowledgement(text: string, isSticker = false): boolean {
  if (isSticker) return true;
  const raw = text.trim();
  if (!raw) return false;
  if (/\d/.test(raw)) return false;
  const words = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zñ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Emoji / punctuation only ("👍", "🙏🏻", "!!").
  if (words.length === 0) return true;
  return words.length <= 8 && words.every((w) => ACK_WORDS.has(w));
}

/** Timestamp of this chat's transfer notice if sent within the window, else null. */
async function findRecentTransferNotice(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const since = new Date(Date.now() - TRANSFER_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .neq("sender_type", "customer")
    .like("content_text", `${TRANSFER_NOTICE_PREFIX}%`)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.created_at as string | undefined) ?? null;
}

/**
 * Decide an inbound message on a chat that was transferred out.
 * `acknowledged` — handled here (farewell sent, or silence after the cap);
 * `to_ai` — skip Flows, let the AI assistant answer;
 * null — not a recently transferred-out chat (or a human owns it): normal path.
 * Best-effort: any lookup failure returns null (normal path).
 */
export async function routeInboundAfterOutboundTransfer(args: {
  db: SupabaseClient;
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  text: string;
  isSticker: boolean;
}): Promise<"acknowledged" | "to_ai" | null> {
  try {
    const { data: conv } = await args.db
      .from("conversations")
      .select("assigned_agent_id")
      .eq("id", args.conversationId)
      .maybeSingle();
    if (conv?.assigned_agent_id) return null;

    const noticeAt = await findRecentTransferNotice(args.db, args.conversationId);
    if (!noticeAt) return null;

    if (!isAcknowledgement(args.text, args.isSticker)) return "to_ai";

    const { count } = await args.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", args.conversationId)
      .eq("content_text", TRANSFER_FAREWELL_TEXT)
      .gte("created_at", noticeAt);
    if ((count ?? 0) < MAX_FAREWELLS) {
      await engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text: TRANSFER_FAREWELL_TEXT,
      });
    }
    return "acknowledged";
  } catch (err) {
    console.error(
      "[line-transfer] outbound routing failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** The source-side transfer note, for the AI, if this chat was transferred out recently. */
export async function loadOutboundTransferContext(
  db: SupabaseClient,
  conversationId: string,
  contactId: string,
): Promise<string | null> {
  try {
    if (!(await findRecentTransferNotice(db, conversationId))) return null;
    const { data } = await db
      .from("contact_notes")
      .select("note_text")
      .eq("contact_id", contactId)
      .like("note_text", `${OUTBOUND_NOTE_PREFIX}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.note_text as string | undefined) ?? "🔀 Derivado a otra línea de Sagama.";
  } catch {
    return null;
  }
}
