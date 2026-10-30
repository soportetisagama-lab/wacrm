import { describe, expect, it } from "vitest";
import { mergeLoadedConversations } from "./merge-loaded-conversations";
import type { Conversation } from "@/types";

const T0 = "2026-10-30T10:00:00.000Z";
const T1 = "2026-10-30T10:00:05.000Z";

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    user_id: "u",
    contact_id: `ct-${id}`,
    status: "open",
    unread_count: 0,
    created_at: T0,
    updated_at: T0,
    last_message_at: T0,
    ...patch,
  };
}

const merge = (
  local: Conversation[],
  loaded: Conversation[],
  known: string[] = local.map((c) => c.id),
  active: { id: string; viewer: string } | null = null,
) =>
  mergeLoadedConversations({
    local,
    loaded,
    knownAtStart: new Set(known),
    activeConversationId: active?.id ?? null,
    viewerId: active?.viewer,
  });

describe("mergeLoadedConversations", () => {
  it("takes the read row when it is newer (missed realtime events)", () => {
    const [row] = merge(
      [conv("a", { unread_count: 1 })],
      [conv("a", { unread_count: 7, updated_at: T1 })],
    );
    expect(row.unread_count).toBe(7);
  });

  it("keeps the local row when its updated_at is newer", () => {
    const [row] = merge(
      [conv("a", { unread_count: 3, updated_at: T1 })],
      [conv("a", { unread_count: 0 })],
    );
    expect(row.unread_count).toBe(3);
  });

  it("keeps a message patched locally before its conversation UPDATE lands", () => {
    const [row] = merge(
      [conv("a", { unread_count: 1, last_message_at: T1, last_message_text: "nuevo" })],
      [conv("a", { unread_count: 0, last_message_text: "viejo" })],
    );
    expect(row.unread_count).toBe(1);
    expect(row.last_message_text).toBe("nuevo");
  });

  it("takes the read row on a full tie", () => {
    const [row] = merge(
      [conv("a", { unread_count: 1 })],
      [conv("a", { unread_count: 2 })],
    );
    expect(row.unread_count).toBe(2);
  });

  it("keeps the contact when the winning row has none", () => {
    const contact = { id: "ct-a", name: "Ana" } as Conversation["contact"];
    const [row] = merge(
      [conv("a", { updated_at: T1 })],
      [conv("a", { contact })],
    );
    expect(row.contact).toBe(contact);
  });

  it("keeps a chat that appeared during the read", () => {
    const rows = merge([conv("new")], [conv("a")], []);
    expect(rows.map((c) => c.id).sort()).toEqual(["a", "new"]);
  });

  it("does not bring back a chat that was on screen and is gone", () => {
    const rows = merge([conv("gone"), conv("a")], [conv("a")]);
    expect(rows.map((c) => c.id)).toEqual(["a"]);
  });

  it("keeps the open chat at 0 unread for its assigned agent", () => {
    const [row] = merge(
      [conv("a", { assigned_agent_id: "me", unread_count: 0 })],
      [conv("a", { assigned_agent_id: "me", unread_count: 5 })],
      ["a"],
      { id: "a", viewer: "me" },
    );
    expect(row.unread_count).toBe(0);
  });

  it("does not clear unread for a supervisor looking at someone else's chat", () => {
    const [row] = merge(
      [conv("a", { assigned_agent_id: "other" })],
      [conv("a", { assigned_agent_id: "other", unread_count: 5 })],
      ["a"],
      { id: "a", viewer: "me" },
    );
    expect(row.unread_count).toBe(5);
  });

  it("does not clear unread for an open chat nobody is assigned", () => {
    const [row] = merge(
      [conv("a")],
      [conv("a", { unread_count: 5 })],
      ["a"],
      { id: "a", viewer: "me" },
    );
    expect(row.unread_count).toBe(5);
  });

  it("does not clear unread on chats that are not open", () => {
    const [row] = merge(
      [conv("a", { assigned_agent_id: "me" })],
      [conv("a", { assigned_agent_id: "me", unread_count: 5 })],
      ["a"],
      { id: "b", viewer: "me" },
    );
    expect(row.unread_count).toBe(5);
  });
});
