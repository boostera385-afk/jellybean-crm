import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { verifyQuoWebhook } from "./quo-webhook-verify.ts";
import { readQuoMessageEvent } from "./quo-webhook-event.ts";

/**
 * Quo message webhook: read-only, comparison-only.
 *
 * Quo does not send a Supabase JWT, so this runs with verify_jwt = false and
 * authenticates every delivery itself. Nothing is trusted before that check
 * passes, and the body is read as raw text because the signature covers bytes:
 * parsing and re-serializing reorders keys and would never match again.
 *
 * All this does is record that something happened to a phone number and park
 * the matching leads for a recheck. It never sends a message, never writes
 * qualified_leads.cs_status, and never calls Quo or a model -- that work
 * belongs to the leased worker, which refuses to classify partial history.
 * Keeping the handler this thin is the point: a burst of events costs a burst
 * of index lookups, not a burst of history syncs.
 *
 * Status codes are instructions to Quo, not decoration. A 2xx stops
 * redelivery, anything else brings the event back. So a delivery that is
 * verified but uninteresting answers 200 and is deliberately dropped, while
 * our own failures answer 5xx so Quo retries into an idempotent handler.
 */

/** Generous next to a text plus media metadata, far below a memory risk. */
const MAX_BODY_BYTES = 512 * 1024;

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleQuoWebhook(req: Request): Promise<Response> {
  if (req.method !== "POST") return text("Method not allowed", 405);

  const secret = Deno.env.get("QUO_WEBHOOK_SECRET");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Retryable on purpose: a delivery must not be lost because a secret was
  // momentarily absent during a deploy.
  if (!secret || !url || !key) return text("Webhook not configured", 503);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return text("Payload too large", 413);

  const verified = await verifyQuoWebhook({ headers: req.headers, body: raw, secret });
  if (!verified.ok) {
    // The reason goes to our logs only; the response stays opaque so it cannot
    // be used to probe which part of the signature was wrong.
    console.warn("Rejected Quo webhook delivery", { reason: verified.reason });
    return text("Unauthorized", 401);
  }

  const event = readQuoMessageEvent(raw);
  if (event.kind === "ignored") {
    console.info("Accepted and ignored Quo webhook delivery", {
      id: verified.webhookId,
      reason: event.reason,
    });
    return text("Ignored", 200);
  }

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.rpc("accept_quo_webhook_event", {
    p_webhook_id: verified.webhookId,
    p_event_type: event.type,
    // Normalization and lead matching happen in SQL, against the same indexed
    // lead_ai_phone() the worker's identity guard uses, so the webhook cannot
    // disagree with it about which lead a number belongs to.
    p_phone: event.participant,
  });
  if (error) {
    // Idempotent on the signed webhook-id, so a redelivery after a partial
    // failure re-runs safely. Better that than dropping the event.
    console.error("Could not record Quo webhook event", { message: error.message });
    return text("Could not record event", 503);
  }

  const result = (data ?? {}) as { duplicate?: boolean; matched?: number };
  // Never echo the phone number or any message content back to the caller.
  return text(result.duplicate ? "Duplicate" : `Queued ${result.matched ?? 0}`, 200);
}

if (import.meta.main) Deno.serve(handleQuoWebhook);
