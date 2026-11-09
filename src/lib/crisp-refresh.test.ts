import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationSummaryChanged, createCoalescedRefresh } from "./crisp-refresh";

afterEach(() => vi.useRealTimers());

describe("Crisp summary invalidation", () => {
  const conversation = {
    crisp_website_id: "one",
    unread_count: 1,
    last_message: "Hi",
    last_customer_unread_at: "today",
  };

  it("ignores unrelated conversation metadata", () => {
    expect(
      conversationSummaryChanged({
        eventType: "UPDATE",
        old: conversation,
        new: { ...conversation, customer_name: "Alice" },
      }),
    ).toBe(false);
  });
  it("keeps masked-message and timestamp changes visible", () => {
    for (const patch of [
      { last_message: "xxxxx" },
      { last_customer_unread_at: "later" },
      { unread_count: 0 },
    ]) {
      expect(
        conversationSummaryChanged({
          eventType: "UPDATE",
          old: conversation,
          new: { ...conversation, ...patch },
        }),
      ).toBe(true);
    }
  });
  it("fails safe for partial old rows and always handles inserts/deletes", () => {
    for (const eventType of ["INSERT", "DELETE", "UPDATE"]) {
      expect(conversationSummaryChanged({ eventType, old: {}, new: conversation })).toBe(true);
    }
  });
});

describe("coalesced refresh", () => {
  it("collapses a burst into one read", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {});
    const refresh = createCoalescedRefresh(read);
    for (let i = 0; i < 100; i++) refresh.schedule();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(1);
    refresh.dispose();
  });
  it("never overlaps reads and retains a trailing event", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const read = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = createCoalescedRefresh(read);
    refresh.schedule();
    await vi.advanceTimersByTimeAsync(150);
    for (let i = 0; i < 100; i++) refresh.schedule();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(2);
    refresh.dispose();
    finish();
  });
  it("recovers after a rejected read", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const refresh = createCoalescedRefresh(read);
    refresh.schedule();
    await vi.advanceTimersByTimeAsync(150);
    refresh.schedule();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(2);
    refresh.dispose();
  });
  it("does not run queued reads after cleanup", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {});
    const refresh = createCoalescedRefresh(read);
    refresh.schedule();
    refresh.dispose();
    refresh.schedule();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).not.toHaveBeenCalled();
  });
});
