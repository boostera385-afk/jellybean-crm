import { timingSafeEqual } from "./crisp-policy.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type SiteArrival = { website_id: string; session_id: string; request_id: string };
export type SiteCheck = { website_id: string; request_id: string; action: "check" };

/** Connectivity checks authenticate the relay without creating a fake visitor. */
export function parseSiteCheck(raw: string): SiteCheck | null {
  if (new TextEncoder().encode(raw).length > 2048) return null;
  try {
    const body = JSON.parse(raw);
    if (
      body?.action !== "check" ||
      typeof body.website_id !== "string" ||
      !UUID.test(body.website_id) ||
      typeof body.request_id !== "string" ||
      !UUID.test(body.request_id)
    )
      return null;
    return { website_id: body.website_id, request_id: body.request_id, action: "check" };
  } catch {
    return null;
  }
}

export async function wakeSiteArrival(
  wake: () => Promise<void>,
  pending: () => Promise<boolean>,
  sleep: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 2000)),
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await wake();
    if (attempt === 2) return;
    await sleep();
    if (!(await pending())) return;
  }
}

export function parseSiteArrival(raw: string): SiteArrival | null {
  if (new TextEncoder().encode(raw).length > 2048) return null;
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (
      typeof body.website_id !== "string" ||
      !UUID.test(body.website_id) ||
      typeof body.request_id !== "string" ||
      !UUID.test(body.request_id) ||
      typeof body.session_id !== "string" ||
      !body.session_id.startsWith("session_") ||
      !UUID.test(body.session_id.slice(8))
    )
      return null;
    return {
      website_id: body.website_id,
      session_id: body.session_id,
      request_id: body.request_id,
    };
  } catch {
    return null;
  }
}

/** Server-to-server signature over the exact bytes, not reserialized JSON. */
export async function verifySiteArrival(
  raw: string,
  timestamp: string | null,
  signature: string | null,
  key: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !timestamp ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 60_000 ||
    !signature ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !/^[a-f0-9]{64}$/.test(key)
  )
    return false;
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    hmac,
    new TextEncoder().encode(`${timestamp}.${raw}`),
  );
  const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return timingSafeEqual(expected, signature);
}
