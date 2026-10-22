import { describe, expect, it, vi } from "vitest";
import {
  advanceQuoCheckpoint,
  createQuoCheckpoint,
  decryptQuoCheckpoint,
  encryptQuoCheckpoint,
} from "../../supabase/functions/_shared/quo-sync";

const snapshot = "2026-10-21T10:00:00Z";
const inboxes = Array.from({ length: 39 }, (_, i) => `PN${i}`);
const response = (data: unknown[] = [], token: string | null = null) =>
  new Response(JSON.stringify({ data, nextPageToken: token }));
describe("resumable full-account Quo history", () => {
  it("covers all 39 inboxes across bounded chunks with no omissions or premature completion", async () => {
    const fetcher = vi.fn().mockImplementation(async () => response());
    let c = createQuoCheckpoint(snapshot, ["9105551234"]);
    const visited: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await advanceQuoCheckpoint(c, { apiKey: "test", inboxIds: inboxes, fetcher });
      expect(result.complete).toBe(i === 2);
      expect(result.total).toBe(39);
      expect(result.done).toBe([16, 32, 39][i]);
      c = result.checkpoint;
    }
    for (const [input] of fetcher.mock.calls) {
      const url = new URL(String(input));
      visited.push(url.searchParams.get("phoneNumberId")!);
      expect(url.searchParams.get("createdBefore")).toBe(snapshot);
    }
    expect(visited).toEqual(inboxes);
  });
  it("resumes the same page cursor after encryption and does not advance an incomplete inbox", async () => {
    const start = createQuoCheckpoint(snapshot, ["9105551234"]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([], "page2"))
      .mockResolvedValueOnce(response());
    const first = await advanceQuoCheckpoint(start, {
      apiKey: "test",
      inboxIds: ["PN1"],
      fetcher,
      maxRequests: 1,
    });
    expect(first.complete).toBe(false);
    expect(first.done).toBe(0);
    const encrypted = await encryptQuoCheckpoint(first.checkpoint, "test-secret", "run-1");
    const resumed = await decryptQuoCheckpoint(encrypted, "test-secret", "run-1");
    const second = await advanceQuoCheckpoint(resumed, {
      apiKey: "test",
      inboxIds: ["PN1"],
      fetcher,
      maxRequests: 1,
    });
    expect(second.complete).toBe(true);
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("pageToken")).toBe("page2");
  });
  it("never stores plaintext, and authenticates both the key and run binding", async () => {
    const c = createQuoCheckpoint(snapshot, ["9105551234"]);
    const encrypted = await encryptQuoCheckpoint(c, "test-secret", "run-1");
    expect(encrypted).not.toContain("9105551234");
    expect(await decryptQuoCheckpoint(encrypted, "test-secret", "run-1")).toEqual(c);
    await expect(decryptQuoCheckpoint(encrypted, "wrong-secret", "run-1")).rejects.toThrow(
      "invalid_checkpoint",
    );
    await expect(decryptQuoCheckpoint(encrypted, "test-secret", "run-2")).rejects.toThrow(
      "invalid_checkpoint",
    );
  });
  it("does not mutate the saved checkpoint when a later page fails", async () => {
    const c = createQuoCheckpoint(snapshot, ["9105551234"]);
    const before = structuredClone(c);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response("unavailable", { status: 429 }));
    await expect(
      advanceQuoCheckpoint(c, { apiKey: "test", inboxIds: inboxes, fetcher }),
    ).rejects.toThrow("quo_rate_limited");
    expect(c).toEqual(before);
  });
  it("detects repeated cursors across worker invocations", async () => {
    const fetcher = vi.fn().mockImplementation(async () => response([], "same"));
    const c = createQuoCheckpoint(snapshot, ["9105551234"]);
    const first = await advanceQuoCheckpoint(c, {
      apiKey: "test",
      inboxIds: ["PN1"],
      fetcher,
      maxRequests: 1,
    });
    await expect(
      advanceQuoCheckpoint(first.checkpoint, {
        apiKey: "test",
        inboxIds: ["PN1"],
        fetcher,
        maxRequests: 1,
      }),
    ).rejects.toThrow("incomplete_history");
  });
  it("covers secondary customer numbers rather than mistaking them for a group chat", async () => {
    const fetcher = vi.fn().mockImplementation(async () => response());
    const c = createQuoCheckpoint(snapshot, ["9105551234", "9105556789"]);
    const result = await advanceQuoCheckpoint(c, {
      apiKey: "test",
      inboxIds: ["PN1", "PN2"],
      fetcher,
    });
    expect(result.complete).toBe(true);
    expect(result.total).toBe(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
