import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillQuoMessages } from "../../supabase/functions/_shared/quo-backfill";

const lead = {
  leadId: "lead-1",
  attempts: 1,
  inboxIds: ["PN1"],
  inboxMatched: true,
  customerNumber: "9105551234",
  customerNumber2: null,
  extraNumbers: [],
};
const message = (id: string) => ({
  id,
  text: "hello",
  direction: "outgoing",
  status: "delivered",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  conversationId: "CN1",
  phoneNumberId: "PN1",
  to: ["+19105551234"],
  from: "+15550000000",
});

function fakeDb(leads: Array<typeof lead>, unique = true) {
  const queue = [...leads];
  const rpc = vi.fn().mockImplementation(async (name: string) => {
    if (name === "claim_quo_message_backfill") return { data: queue.shift() ?? null, error: null };
    if (name === "lead_ai_phone_is_unique") return { data: unique, error: null };
    return { data: true, error: null };
  });
  return { rpc, from: vi.fn() };
}
const calls = (db: ReturnType<typeof fakeDb>, name: string) =>
  db.rpc.mock.calls.filter(([n]) => n === name).map(([, args]) => args);

afterEach(() => vi.unstubAllGlobals());

describe("Quo conversation backfill", () => {
  it("saves a lead's complete history and marks it done", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: [message("M1"), message("M2")], nextPageToken: null }),
          ),
        ),
    );
    const db = fakeDb([lead]);
    const result = await backfillQuoMessages(db as never, "key", ["PN1", "PN2"], {
      wait: async () => {},
    });
    expect(result).toMatchObject({ done: 1, messages: 2, idle: true });
    expect(calls(db, "store_quo_messages")[0]).toMatchObject({ p_lead_id: "lead-1" });
    expect(calls(db, "store_quo_messages")[0].p_messages).toHaveLength(2);
    expect(calls(db, "finish_quo_message_backfill")[0]).toMatchObject({
      p_state: "done",
      p_message_count: 2,
    });
    // Reads and saves only: never classifies or publishes a status.
    expect(calls(db, "finish_quo_ai_job")).toHaveLength(0);
  });

  it("skips a number shared with another lead when reading every inbox", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const db = fakeDb([{ ...lead, inboxMatched: false }], false);
    const result = await backfillQuoMessages(db as never, "key", ["PN1"], {
      wait: async () => {},
    });
    expect(result).toMatchObject({ skipped: 1, done: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(calls(db, "store_quo_messages")).toHaveLength(0);
    expect(calls(db, "finish_quo_message_backfill")[0]).toMatchObject({
      p_state: "skipped",
      p_reason: "phone_shared_between_leads",
    });
  });

  it("re-queues a lead on a temporary Quo failure without saving a partial chat", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    const db = fakeDb([lead]);
    const result = await backfillQuoMessages(db as never, "key", ["PN1"], {
      wait: async () => {},
    });
    expect(result).toMatchObject({ requeued: 1, done: 0 });
    expect(calls(db, "store_quo_messages")).toHaveLength(0);
    expect(calls(db, "finish_quo_message_backfill")[0]).toMatchObject({
      p_state: "pending",
      p_reason: "quo_rate_limited",
    });
  });

  it("records an unfixable history as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: [{ ...message("M1"), to: ["+1999"] }], nextPageToken: null }),
          ),
        ),
    );
    const db = fakeDb([lead]);
    const result = await backfillQuoMessages(db as never, "key", ["PN1"], {
      wait: async () => {},
    });
    expect(result).toMatchObject({ error: 1 });
    expect(calls(db, "finish_quo_message_backfill")[0]).toMatchObject({
      p_state: "error",
      p_reason: "ambiguous_conversation",
    });
  });
});

describe("Quo conversation backfill time limits", () => {
  it("re-queues a lead whose history does not finish within its own budget", async () => {
    let clock = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        clock += 1_000;
        return new Response(JSON.stringify({ data: [], nextPageToken: null }));
      }),
    );
    const db = fakeDb([{ ...lead, inboxIds: Array.from({ length: 40 }, (_, i) => `PN${i}`) }]);
    const result = await backfillQuoMessages(db as never, "key", ["PN1"], {
      wait: async () => {},
      now: () => clock,
      budgetMs: 100_000,
      leadBudgetMs: 20_000,
    });
    expect(result.requeued).toBe(1);
    expect(calls(db, "store_quo_messages")).toHaveLength(0);
    expect(calls(db, "finish_quo_message_backfill")[0]).toMatchObject({
      p_state: "pending",
      p_reason: "backfill_time_budget",
    });
  });
});
