// Shared by the server push (pending-replies.ts) and the web reminder
// (PendingRepliesReminder) — kept apart so the client bundle never
// pulls in the server-only push/Firebase code.

export const REMINDER_EVERY_MS = 10 * 60_000;

export function pendingRepliesText(count: number): { title: string; body: string } {
  return {
    title: count === 1 ? "Tienes 1 chat por responder" : `Tienes ${count} chats por responder`,
    body: "Te faltan responder mensajes en el sistema. Contéstalos lo más pronto posible.",
  };
}
