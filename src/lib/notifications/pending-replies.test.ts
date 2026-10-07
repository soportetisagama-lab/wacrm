import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendPush = vi.fn();
vi.mock("./push-send", () => ({ sendPushToUser: (...args: unknown[]) => mockSendPush(...args) }));

import {
  countPendingReplies,
  remindPendingReplies,
  resetPendingRepliesReminder,
} from "./pending-replies";

type Row = Record<string, unknown>;

/** Just enough of the query builder: filters are ignored except the
 *  ones the tests rely on (conversation_id `in`, agent `eq`), and rows
 *  come back in the order given (messages already newest-first). */
function fakeDb(conversations: Row[], messages: Row[]) {
  return {
    from(table: string) {
      let rows = table === "conversations" ? conversations : messages;
      const q = {
        select: () => q,
        in: (col: string, vals: unknown[]) => {
          if (col === "conversation_id") rows = rows.filter((r) => vals.includes(r.conversation_id));
          return q;
        },
        not: () => q,
        gte: () => q,
        order: () => q,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return q;
        },
        then: (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data: rows, error: null }),
      };
      return q;
    },
  } as never;
}

const CONVS = [
  { id: "c1", assigned_agent_id: "ana" },
  { id: "c2", assigned_agent_id: "ana" },
  { id: "c3", assigned_agent_id: "luis" },
];
// Newest first per conversation.
const MSGS = [
  { conversation_id: "c1", sender_type: "customer" }, // c1: customer last → pending
  { conversation_id: "c1", sender_type: "agent" },
  { conversation_id: "c2", sender_type: "agent" }, // c2: answered
  { conversation_id: "c2", sender_type: "customer" },
  { conversation_id: "c3", sender_type: "customer" }, // c3: never answered → pending
];

// Tuesday 10:00 Lima (15:00 UTC) — within business hours.
const OPEN = new Date("2026-10-06T15:00:00Z");

describe("countPendingReplies", () => {
  it("counts chats whose latest customer message is newer than the latest agent reply", async () => {
    const counts = await countPendingReplies(fakeDb(CONVS, MSGS), { now: OPEN });
    expect(Object.fromEntries(counts)).toEqual({ ana: 1, luis: 1 });
  });

  it("can count one agent only", async () => {
    const counts = await countPendingReplies(fakeDb(CONVS, MSGS), { agentId: "ana", now: OPEN });
    expect(Object.fromEntries(counts)).toEqual({ ana: 1 });
  });
});

describe("remindPendingReplies", () => {
  beforeEach(() => {
    mockSendPush.mockReset();
    resetPendingRepliesReminder();
  });

  it("pushes each agent with pending chats, then waits ~10 minutes before the next round", async () => {
    await remindPendingReplies(fakeDb(CONVS, MSGS), OPEN);
    expect(mockSendPush).toHaveBeenCalledTimes(2);
    expect(mockSendPush).toHaveBeenCalledWith("ana", expect.objectContaining({ title: "Tienes 1 chat por responder" }));

    await remindPendingReplies(fakeDb(CONVS, MSGS), new Date(OPEN.getTime() + 5 * 60_000));
    expect(mockSendPush).toHaveBeenCalledTimes(2);

    await remindPendingReplies(fakeDb(CONVS, MSGS), new Date(OPEN.getTime() + 10 * 60_000));
    expect(mockSendPush).toHaveBeenCalledTimes(4);
  });

  it("stays quiet outside business hours", async () => {
    // Sunday 10:00 Lima.
    await remindPendingReplies(fakeDb(CONVS, MSGS), new Date("2026-10-04T15:00:00Z"));
    expect(mockSendPush).not.toHaveBeenCalled();
  });
});
