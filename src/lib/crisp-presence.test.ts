import { describe, expect, it } from "vitest";
import { countCheckDue, readPresence } from "../../supabase/functions/_shared/crisp-presence";
import { verifyPluginHook } from "../../supabase/functions/_shared/crisp-hooks";
import { createHmac } from "node:crypto";

const reply = (data: unknown, status = 200) => Response.json({ data }, { status });
function responses(...items: Response[]) {
  const paths: string[] = [];
  return {
    paths,
    get: async (path: string) => {
      paths.push(path);
      if (!items.length) throw new Error("Unexpected request");
      return items.shift()!;
    },
  };
}

describe("identity-aware presence reads", () => {
  it("reads identities even when an arrival replaces a departure at the same count", async () => {
    const api = responses(reply([{ session_id: "replacement" }]));
    const result = await readPresence(api.get, false);
    expect(api.paths).toEqual(["list/1"]);
    expect(result.rows.map((v) => v.session_id)).toEqual(["replacement"]);
    expect(result.complete).toBe(false);
    expect(result.count).toBeNull();
    expect(result.limited).toBeNull();
  });
  it("never sweeps absence on an empty identity-only pass", async () => {
    const result = await readPresence(responses(reply([])).get, false);
    expect(result.complete).toBe(false);
    expect(result.error).toBeNull();
  });
  it("accepts a validated empty snapshot without a list call", async () => {
    const api = responses(reply({ count: 0, active: 0, limited: false }));
    expect((await readPresence(api.get, true)).complete).toBe(true);
    expect(api.paths).toEqual(["count"]);
  });
  it("validates full snapshots against the unique visitor count", async () => {
    const api = responses(reply({ count: 1, limited: false }), reply([{ session_id: "one" }]));
    expect((await readPresence(api.get, true)).complete).toBe(true);
  });
  it("does not treat HTTP 206 as complete even when count matches", async () => {
    const api = responses(
      reply({ count: 1, limited: false }),
      reply([{ session_id: "one" }], 206),
      reply([{ session_id: "two" }]),
    );
    const result = await readPresence(api.get, true);
    expect(api.paths).toEqual(["count", "list/1", "list/2"]);
    expect(result.complete).toBe(false);
    expect(result.error).toMatch(/mismatch/);
    expect(result.rows).toHaveLength(2);
  });
  it("follows partial pages on identity passes", async () => {
    const api = responses(reply([{ session_id: "one" }], 206), reply([{ session_id: "two" }]));
    const result = await readPresence(api.get, false);
    expect(result.rows).toHaveLength(2);
    expect(result.complete).toBe(false);
  });
  it("never establishes absence for limited counts", async () => {
    const api = responses(reply({ count: 1, limited: true }), reply([{ session_id: "one" }]));
    expect((await readPresence(api.get, true)).complete).toBe(false);
  });
  it("cached counters never suppress identity reads or establish absence", async () => {
    const cachedCount = Response.json(
      { data: { count: 0, limited: false } },
      { headers: { "Bloom-Status": "HIT" } },
    );
    const api = responses(cachedCount, reply([{ session_id: "new" }]));
    const result = await readPresence(api.get, true);
    expect(api.paths).toEqual(["count", "list/1"]);
    expect(result.rows).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
  it("cached list responses cannot establish absence", async () => {
    const cachedList = Response.json(
      { data: [{ session_id: "one" }] },
      { headers: { "Bloom-Status": "HIT" } },
    );
    const result = await readPresence(
      responses(reply({ count: 1, limited: false }), cachedList).get,
      true,
    );
    expect(result.complete).toBe(false);
    expect(result.error).toBeNull();
  });
  it("keeps earlier pages but rejects duplicates and malformed pages", async () => {
    for (const page of [[{ session_id: "one" }], [{ session_id: "" }], [null]]) {
      const api = responses(reply([{ session_id: "one" }], 206), reply(page));
      const result = await readPresence(api.get, false);
      expect(result.error).not.toBeNull();
      expect(result.rows).toEqual([{ session_id: "one" }]);
      expect(result.complete).toBe(false);
    }
  });
  it("rejects a short empty page before reaching the count", async () => {
    const api = responses(reply({ count: 2, limited: false }), reply([]));
    expect((await readPresence(api.get, true)).error).toMatch(/mismatch/);
  });
  it("bounds pagination and retains discovered arrivals", async () => {
    const api = responses(
      ...Array.from({ length: 10 }, (_, i) => reply([{ session_id: String(i) }], 206)),
    );
    const result = await readPresence(api.get, false);
    expect(result.requests).toBe(10);
    expect(result.rows).toHaveLength(10);
    expect(result.error).toMatch(/limit/);
  });
  it("handles errors, invalid counters and budget rejection conservatively", async () => {
    for (const counter of [
      { count: -1, limited: false },
      { count: 0 },
      { count: 1.5, limited: false },
    ]) {
      expect((await readPresence(responses(reply(counter)).get, true)).complete).toBe(false);
    }
    const result = await readPresence(async () => {
      throw new Error("Budget reached");
    }, false);
    expect(result.error).toBe("Budget reached");
    expect(result.rows).toEqual([]);
  });
  it("checks counters on their own cadence, not from count equality", () => {
    expect(countCheckDue(null)).toBe(true);
    expect(countCheckDue("invalid")).toBe(true);
    expect(countCheckDue(new Date(0).toISOString(), 44_999)).toBe(false);
    expect(countCheckDue(new Date(0).toISOString(), 45_000)).toBe(true);
  });
});

describe("signed plugin hooks", () => {
  const body = {
    website_id: "test",
    event: "session:update_availability",
    data: { session_id: "one", availability: "online" },
  };
  const secret = "test-only-signing-secret";
  const now = 1_792_128_000_000;
  const signature = (timestamp: string, payload = body) =>
    createHmac("sha256", secret)
      .update(`[${Number(timestamp)};${JSON.stringify(payload)}]`)
      .digest("hex");
  it("matches the official SDK's HMAC format with seconds or milliseconds", async () => {
    for (const timestamp of [String(now), String(now / 1000)])
      expect(await verifyPluginHook(body, timestamp, signature(timestamp), secret, now)).toBe(true);
  });
  it("rejects missing secrets, unsigned, forged, stale and changed payloads", async () => {
    const timestamp = String(now);
    expect(await verifyPluginHook(body, timestamp, signature(timestamp), "", now)).toBe(false);
    expect(await verifyPluginHook(body, timestamp, null, secret, now)).toBe(false);
    expect(await verifyPluginHook(body, timestamp, "0".repeat(64), secret, now)).toBe(false);
    expect(
      await verifyPluginHook(body, timestamp, signature(timestamp), secret, now + 300_001),
    ).toBe(false);
    expect(
      await verifyPluginHook(
        { ...body, website_id: "other" },
        timestamp,
        signature(timestamp),
        secret,
        now,
      ),
    ).toBe(false);
  });
});
