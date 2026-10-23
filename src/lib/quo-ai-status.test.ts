import { describe, expect, it, vi } from "vitest";
import {
  classifyQuoHistory,
  fetchQuoHistory,
  isQuoConfigurationProbe,
  isQuoWorker,
  normalizeQuoPhone,
  resolveQuoPhoneIds,
  safeAiError,
  NO_REPLY_MS,
  transportResult,
  validateIntent,
  type QuoMessage,
} from "../../supabase/functions/_shared/quo-ai-status";

const assigned = "2026-10-20T10:00:00Z";
const message = (change: Partial<QuoMessage> = {}): QuoMessage => ({
  id: "AC1",
  text: "Hi, interested",
  direction: "incoming",
  status: "received",
  createdAt: "2026-10-20T11:00:00Z",
  updatedAt: "2026-10-20T11:00:00Z",
  conversationId: "CN1",
  phoneNumberId: "PN1",
  from: "+19105551234",
  to: ["+19105559999"],
  ...change,
});
const outgoing = (change: Partial<QuoMessage> = {}) =>
  message({
    direction: "outgoing",
    status: "delivered",
    from: "+19105559999",
    to: ["+19105551234"],
    ...change,
  });
const page = (data: QuoMessage[], nextPageToken: string | null = null) =>
  new Response(JSON.stringify({ data, nextPageToken, totalItems: 0 }));

describe("automatic Quo inbox discovery", () => {
  it("limits backend credentials to read-only configuration probes", () => {
    expect(isQuoConfigurationProbe("backend-secret", "backend-secret", "configuration")).toBe(true);
    expect(isQuoConfigurationProbe("backend-secret", "backend-secret", "refresh")).toBe(false);
    expect(isQuoConfigurationProbe("forged", "backend-secret", "configuration")).toBe(false);
    expect(isQuoConfigurationProbe("", "", "configuration")).toBe(false);
    expect(isQuoWorker("backend-secret", "backend-secret", "work")).toBe(true);
    // The unattended sweep is the cron's alone: it picks its own leads, with no
    // date range and nobody to attribute it to.
    expect(isQuoWorker("backend-secret", "backend-secret", "enqueue")).toBe(true);
    // "refresh" carries a person's chosen range and must stay theirs.
    expect(isQuoWorker("backend-secret", "backend-secret", "refresh")).toBe(false);
    expect(isQuoWorker("forged", "backend-secret", "work")).toBe(false);
    expect(isQuoWorker("forged", "backend-secret", "enqueue")).toBe(false);
    expect(isQuoWorker("backend-secret", "backend-secret", undefined)).toBe(false);
  });
  it("discovers IDs with only an API key and keeps credentials server-side", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "PN1",
              name: "Houston Handyman OP1",
              number: "+12025550101",
              users: [{ email: "private@example.com" }],
            },
            { id: "PN2" },
          ],
        }),
      ),
    );
    const result = await resolveQuoPhoneIds({ apiKey: "test-only", fetcher });
    // The inbox's name and its own business number are kept so a lead's
    // number_name can pick its inbox; the inbox's users never leave here.
    expect(result).toEqual({
      ids: ["PN1", "PN2"],
      source: "discovered",
      names: { PN1: "Houston Handyman OP1" },
      numbers: { PN1: "+12025550101" },
    });
    expect(JSON.stringify(result)).not.toMatch(/private@example/);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.quo.com/v1/phone-numbers");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("test-only");
  });
  it("honors an optional inbox allowlist instead of expanding its scope", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "PN1" }, { id: "PN2" }] })));
    expect(
      await resolveQuoPhoneIds({ apiKey: "test", configuredIds: " PN2,PN2 ", fetcher }),
    ).toEqual({ ids: ["PN2"], source: "configured", names: {}, numbers: {} });
  });
  it.each([
    { body: { data: [] }, error: "no_quo_phone_numbers" },
    { body: { data: [{ id: "unexpected" }] }, error: "invalid_quo_response" },
    { body: { data: [{ id: "PN1" }], nextPageToken: "more" }, error: "invalid_quo_response" },
    {
      body: { data: Array.from({ length: 101 }, (_, i) => ({ id: `PN${i}` })) },
      error: "quo_inbox_allowlist_required",
    },
  ])(
    "fails closed rather than discovering an incomplete/invalid inbox set",
    async ({ body, error }) => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
      await expect(resolveQuoPhoneIds({ apiKey: "test", fetcher })).rejects.toThrow(error);
    },
  );
  it("rejects inaccessible configured inboxes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "PN1" }] })));
    await expect(
      resolveQuoPhoneIds({ apiKey: "test", configuredIds: "PN2", fetcher }),
    ).rejects.toThrow("quo_inbox_unavailable");
  });
  it("discovers the entire 39-inbox production account without a manual ID secret", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: Array.from({ length: 39 }, (_, i) => ({ id: `PN${i}` })),
        }),
      ),
    );
    const result = await resolveQuoPhoneIds({ apiKey: "test", fetcher });
    expect(result.ids).toHaveLength(39);
    expect(result.source).toBe("discovered");
  });
  it.each([
    [401, "quo_auth_failed"],
    [403, "quo_access_denied"],
    [429, "quo_rate_limited"],
  ])("reports API status %s safely", async (status, error) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("private provider details", { status }));
    await expect(resolveQuoPhoneIds({ apiKey: "test", fetcher })).rejects.toThrow(error);
  });
});

describe("Quo identity and full history", () => {
  it.each([
    ["(910) 555-1234", "+19105551234"],
    ["19105551234", "+19105551234"],
    ["+44 20 1234 5678", "+442012345678"],
    ["9105551234 ext 5", null],
    ["123", null],
    [null, null],
  ])("normalizes %s without guessing extensions or foreign country codes", (input, expected) => {
    expect(normalizeQuoPhone(input)).toBe(expected);
  });
  it("fetches every cursor page despite inaccurate totalItems, deduplicates and orders", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([message({ id: "AC2" })], "second"))
      .mockResolvedValueOnce(
        page([message({ id: "AC1", createdAt: assigned }), message({ id: "AC2" })]),
      );
    const rows = await fetchQuoHistory({
      apiKey: "test",
      phoneNumberId: "PN1",
      participant: "+19105551234",
      fetcher,
    });
    expect(rows.map((m) => m.id)).toEqual(["AC1", "AC2"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetcher.mock.calls[1][0]));
    expect(url.searchParams.get("pageToken")).toBe("second");
    expect(url.searchParams.getAll("participants")).toEqual(["+19105551234"]);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("test");
  });
  it("refuses repeated cursors and never classifies truncated history", async () => {
    const fetcher = vi.fn().mockImplementation(async () => page([message()], "same"));
    await expect(
      fetchQuoHistory({
        apiKey: "test",
        phoneNumberId: "PN1",
        participant: "+19105551234",
        fetcher,
      }),
    ).rejects.toThrow("incomplete_history");
  });
  it("rejects unexpected customers", async () => {
    const fetcher = vi.fn().mockResolvedValue(page([message({ from: "+19105558888" })]));
    await expect(
      fetchQuoHistory({
        apiKey: "test",
        phoneNumberId: "PN1",
        participant: "+19105551234",
        fetcher,
      }),
    ).rejects.toThrow("ambiguous_conversation");
  });
  it("fails closed on throttling instead of guessing no history", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("secret provider details", { status: 429 }));
    await expect(
      fetchQuoHistory({
        apiKey: "test",
        phoneNumberId: "PN1",
        participant: "+19105551234",
        fetcher,
      }),
    ).rejects.toThrow("quo_rate_limited");
    expect(safeAiError(new Error("secret provider details"))).toBe("analysis_failed");
  });
});

describe("evidence-based shadow status", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  it("never treats sent/queued as delivered", () => {
    for (const status of ["sent", "queued"])
      expect(transportResult([outgoing({ status })], assigned, now)?.state).toBe("review");
  });
  it("reads delivery from Quo's receipt, with no model", () => {
    expect(transportResult([outgoing()], assigned, now)?.status).toBe("converted");
    expect(transportResult([outgoing({ status: "undelivered" })], assigned, now)?.status).toBe(
      "undeliver",
    );
    expect(transportResult([message()], assigned, now)).toBeNull();
  });
  it("calls it didn't reply after exactly 6 hours with nothing back", () => {
    // outgoing() is sent at 11:00; `now` is 12:00.
    const sent = Date.parse("2026-10-20T11:00:00Z");
    const at = (ms: number) => transportResult([outgoing()], assigned, ms);
    expect(at(sent + NO_REPLY_MS - 1)?.status).toBe("converted");
    expect(at(sent + NO_REPLY_MS)).toMatchObject({
      status: "cx_didnt_replied",
      reasonCode: "no_reply_after_6h",
    });
    expect(NO_REPLY_MS).toBe(6 * 3600_000);
  });
  it("marks a lead we were already talking to before it was created", () => {
    const created = "2026-10-20T09:00:00Z";
    const before = outgoing({ id: "ACold", createdAt: "2026-09-01T10:00:00Z" });
    expect(transportResult([before, outgoing()], assigned, now, created)).toMatchObject({
      state: "classified",
      status: "already_received_before",
      reasonCode: "contacted_before_lead",
      evidenceIds: ["ACold"],
    });
    // A customer who wrote to us first counts the same.
    const theyWrote = message({ id: "ACthem", createdAt: "2026-08-01T10:00:00Z" });
    expect(transportResult([theyWrote], assigned, now, created)?.status).toBe(
      "already_received_before",
    );
  });
  it("skips 'already received before' when the lead is not mapped to its own inbox", () => {
    // Read across every inbox, an older message may belong to another lead.
    const before = outgoing({ id: "ACold", createdAt: "2026-09-01T10:00:00Z" });
    const result = transportResult(
      [before, outgoing()],
      assigned,
      now,
      "2026-10-20T09:00:00Z",
      false,
    );
    expect(result?.status).toBe("converted");
  });
  it("does not count a lead's own messages from before a reassignment as prior contact", () => {
    // Created 09:00, messaged 09:30, reassigned 10:00 with nothing since.
    const own = outgoing({ createdAt: "2026-10-20T09:30:00Z" });
    expect(transportResult([own], assigned, now, "2026-10-20T09:00:00Z")).toMatchObject({
      state: "unmatched",
      status: null,
      reasonCode: "no_contact_yet",
    });
  });
  it("gives a lead nothing has been sent to no status at all", () => {
    expect(transportResult([], assigned, now)).toMatchObject({
      state: "unmatched",
      status: null,
      reasonCode: "no_matching_quo_history",
    });
  });
  it.each([
    { status: "cx_interested", confidence: 0.84, evidenceIds: ["AC1"] },
    { status: "cx_interested", confidence: 2, evidenceIds: ["AC1"] },
    { status: "cx_interested", confidence: 0.95, evidenceIds: ["invented"] },
    { status: "closed_won", confidence: 0.95, evidenceIds: ["AC1"] },
    { status: "wrong_person", confidence: 0.99, evidenceIds: ["AC1"] },
    { status: "wrong_service", confidence: 0.99, evidenceIds: ["AC1"] },
    { status: "small_service", confidence: 0.99, evidenceIds: ["AC1"] },
    { status: "need_follow_up", confidence: 0.99, evidenceIds: ["AC1"] },
    { status: "converted", confidence: 0.95, evidenceIds: ["AC1"] },
  ])("reviews invalid or unsupported intent %j", (value) => {
    expect(validateIntent(value, [message()], assigned).state).toBe("review");
  });
  it("requires incoming evidence from the current assignment", () => {
    const answer = { status: "cx_not_interested", confidence: 0.98, evidenceIds: ["AC1"] };
    expect(validateIntent(answer, [outgoing()], assigned).state).toBe("review");
    expect(
      validateIntent(answer, [message({ createdAt: "2025-01-01T00:00:00Z" })], assigned).state,
    ).toBe("review");
    expect(validateIntent(answer, [message()], assigned).status).toBe("cx_not_interested");
  });
  it("sends complete ordered text and ignores fabricated model evidence", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "cx_interested",
                  confidence: 0.99,
                  evidenceIds: ["fake"],
                }),
              },
            },
          ],
        }),
      ),
    );
    const result = await classifyQuoHistory({
      messages: [message()],
      assignedAt: assigned,
      service: "Painting",
      apiKey: "test",
      fetcher,
    });
    expect(result.state).toBe("review");
    expect(result.historyHash).toHaveLength(64);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[1].content).toContain(
      "Hi, interested",
    );
  });
  it("avoids model cost for receipts, media-only replies and oversized history", async () => {
    const fetcher = vi.fn();
    const classify = (messages: QuoMessage[]) =>
      classifyQuoHistory({
        messages,
        assignedAt: assigned,
        service: null,
        apiKey: "test",
        fetcher,
        now,
      });
    expect((await classify([outgoing()])).status).toBe("converted");
    expect((await classify([message({ text: "", media: [{}] })])).reasonCode).toBe(
      "media_requires_review",
    );
    expect((await classify([message({ text: "x".repeat(180_001) })])).reasonCode).toBe(
      "history_too_large",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
