import { timingSafeEqual } from "./crisp-policy.ts";
import type { RpcClient } from "./crisp-api.ts";

/** Matches node-crisp-api: HMAC-SHA256(`[timestamp;JSON.stringify(body)]`). */
export async function verifyPluginHook(
  body: Record<string, unknown>,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !secret ||
    !timestamp ||
    !/^\d{10}(\d{3})?$/.test(timestamp) ||
    !signature ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    return false;
  const sent = Number(timestamp) * (timestamp.length === 10 ? 1000 : 1);
  if (Math.abs(now - sent) > 5 * 60_000) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`[${Number(timestamp)};${JSON.stringify(body)}]`),
  );
  const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return timingSafeEqual(expected, signature.toLowerCase());
}

/** Durable receipt is committed before this best-effort accelerator starts. */
export async function processAndWake(
  admin: RpcClient,
  url: string,
  serviceKey: string,
  websiteId: string,
  greetingsOnly: boolean,
  eventId: string,
) {
  const start = performance.now();
  const { error } = await admin.rpc("crisp_process_events", {
    p_website_id: websiteId,
    p_limit: 20,
  });
  if (error) throw new Error("Event processing failed");
  const response = await fetch(`${url}/functions/v1/crisp-auto-greet`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ websiteId, greetingsOnly }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Worker wake-up HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== "ok") throw new Error("Worker wake-up incomplete");
  console.info(
    JSON.stringify({
      component: "crisp-event-wake",
      eventId,
      websiteId,
      greeted: result.greeted,
      durationMs: Math.round(performance.now() - start),
    }),
  );
}
