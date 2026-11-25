import { describe, expect, it, vi } from "vitest";
import {
  createMarshmallowLookupHandler,
  MAX_LOOKUPS,
  parseLookupBody,
} from "../../supabase/functions/_shared/marshmallow-lookup";

const SECRET = "test-lookup-secret";
const row = {
  request_key: "lead-1",
  jellybean_lead_id: "00000000-0000-4000-8000-000000000001",
  jellybean_created_at: "2026-11-01T10:00:00.000Z",
  source_role: "maturing",
  department: "ND" as const,
  matched_phone: "+14045550101",
};

function setup(options: { secret?: string | null; rows?: unknown[] | null; fail?: boolean } = {}) {
  const lookup = vi.fn(async () =>
    options.fail ? { data: null, error: new Error("db down") } : { data: (options.rows ?? [row]) as never, error: null },
  );
  const handler = createMarshmallowLookupHandler({
    env: (name) => (name === "MARSHMALLOW_LOOKUP_SECRET" ? (options.secret === null ? undefined : options.secret ?? SECRET) : undefined),
    lookup,
  });
  const call = (body: unknown, secret: string | null = SECRET, method = "POST") =>
    handler(new Request("https://jb.test/functions/v1/marshmallow-lead-lookup", {
      method,
      headers: secret === null ? {} : { "x-marshmallow-secret": secret },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }));
  return { lookup, call };
}

const good = { requests: [{ key: "lead-1", phones: ["(404) 555-0101"], before: "2026-11-02T00:00:00Z" }] };

describe("marshmallow-lead-lookup handler", () => {
  it("returns the department for a matched lead and passes normalised requests to the lookup", async () => {
    const { lookup, call } = setup();
    const res = await call(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      matches: [{
        key: "lead-1",
        jellybean_lead_id: row.jellybean_lead_id,
        jellybean_created_at: row.jellybean_created_at,
        source_role: "maturing",
        department: "ND",
        matched_phone: "+14045550101",
      }],
    });
    expect(lookup).toHaveBeenCalledWith([{ key: "lead-1", phones: ["(404) 555-0101"], before: "2026-11-02T00:00:00.000Z" }]);
  });

  it("returns an empty match list when JellyBean has no lead for the phone", async () => {
    const { call } = setup({ rows: [] });
    expect(await (await call(good)).json()).toEqual({ matches: [] });
  });

  it("refuses a missing or wrong secret without touching the database", async () => {
    const { lookup, call } = setup();
    expect((await call(good, null)).status).toBe(401);
    expect((await call(good, "wrong")).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("is unavailable when the secret is not configured", async () => {
    const { lookup, call } = setup({ secret: null });
    expect((await call(good, "")).status).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("reports a backend failure as 502 rather than 'not found'", async () => {
    const { call } = setup({ fail: true });
    const res = await call(good);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "JellyBean lookup failed." });
  });

  it("rejects non-POST, bad JSON and oversized batches", async () => {
    const { lookup, call } = setup();
    expect((await call(undefined, SECRET, "GET")).status).toBe(405);
    expect((await call("{not json")).status).toBe(400);
    const many = { requests: Array.from({ length: MAX_LOOKUPS + 1 }, (_, i) => ({ key: `k${i}`, phones: [], before: "2026-11-02T00:00:00Z" })) };
    expect((await call(many)).status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("parseLookupBody", () => {
  it("rejects malformed keys, timestamps and phone lists", () => {
    expect(parseLookupBody({ requests: [{ key: "bad key!", phones: [], before: "2026-11-02" }] })).toMatch(/key/);
    expect(parseLookupBody({ requests: [{ key: "a", phones: [], before: "not a date" }] })).toMatch(/before/);
    expect(parseLookupBody({ requests: [{ key: "a", phones: ["1", "2", "3", "4", "5"], before: "2026-11-02" }] })).toMatch(/phone/);
    expect(parseLookupBody({})).toMatch(/array/);
  });
});
