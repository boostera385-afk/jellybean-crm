// Server-to-server lookup used by Marshmallow CRM: "was this customer a
// JellyBean lead before Marshmallow added them, and which department?"
//
// Auth: exact match on the MARSHMALLOW_LOOKUP_SECRET shared secret (header
// x-marshmallow-secret). There is no JellyBean user here, so the gateway JWT
// check is off for this function and the secret is the only way in. The
// response carries department metadata only: no names, notes or phone numbers
// beyond the normalised number Marshmallow already sent.

export const MAX_LOOKUPS = 500;
const MAX_PHONES = 4;
const MAX_BODY_BYTES = 256 * 1024;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;

export type LookupRequest = { key: string; phones: string[]; before: string };
export type LookupMatch = {
  key: string;
  jellybean_lead_id: string;
  jellybean_created_at: string;
  source_role: string | null;
  department: "ND" | "FB" | "SEO" | "Other";
  matched_phone: string;
};
type RpcRow = {
  request_key: string;
  jellybean_lead_id: string;
  jellybean_created_at: string;
  source_role: string | null;
  department: LookupMatch["department"];
  matched_phone: string;
};
export type LookupDeps = {
  env: (name: string) => string | undefined;
  lookup: (requests: LookupRequest[]) => Promise<{ data: RpcRow[] | null; error: unknown }>;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export function sameSecret(provided: string, expected: string): boolean {
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Validates the body; returns the clean requests or a user-facing error. */
export function parseLookupBody(body: unknown): LookupRequest[] | string {
  const list = (body as { requests?: unknown } | null)?.requests;
  if (!Array.isArray(list)) return "requests must be an array";
  if (list.length > MAX_LOOKUPS) return `At most ${MAX_LOOKUPS} lookups per call`;
  const out: LookupRequest[] = [];
  for (const item of list) {
    const { key, phones, before } = (item ?? {}) as Record<string, unknown>;
    if (typeof key !== "string" || !KEY.test(key)) return "Each lookup needs a short key";
    if (typeof before !== "string" || Number.isNaN(Date.parse(before))) return "Each lookup needs a valid before timestamp";
    if (!Array.isArray(phones) || phones.length > MAX_PHONES || phones.some((p) => typeof p !== "string" || p.length > 32)) {
      return "Each lookup needs up to 4 phone numbers";
    }
    out.push({ key, phones: phones as string[], before: new Date(before).toISOString() });
  }
  return out;
}

export function createMarshmallowLookupHandler(deps: LookupDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const expected = deps.env("MARSHMALLOW_LOOKUP_SECRET");
    if (!expected) return json({ error: "Lookup is not configured." }, 503);
    if (!sameSecret(req.headers.get("x-marshmallow-secret") ?? "", expected)) {
      return json({ error: "Invalid lookup secret." }, 401);
    }
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const requests = parseLookupBody(body);
    if (typeof requests === "string") return json({ error: requests }, 400);
    if (!requests.length) return json({ matches: [] });
    const { data, error } = await deps.lookup(requests);
    if (error || !Array.isArray(data)) return json({ error: "JellyBean lookup failed." }, 502);
    const matches: LookupMatch[] = data.map((row) => ({
      key: row.request_key,
      jellybean_lead_id: row.jellybean_lead_id,
      jellybean_created_at: row.jellybean_created_at,
      source_role: row.source_role,
      department: row.department,
      matched_phone: row.matched_phone,
    }));
    return json({ matches });
  };
}
