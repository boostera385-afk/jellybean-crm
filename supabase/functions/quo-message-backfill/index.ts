import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolveQuoPhoneIds, safeAiError } from "../_shared/quo-ai-status.ts";
import { backfillQuoMessages, type BackfillDb } from "../_shared/quo-backfill.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * One-off: save the Quo conversations of leads queued with
 * seed_quo_message_backfill. Reads and saves only; never changes a status.
 * Backend only -- the caller must present the exact service-role key.
 */
export async function handleBackfill(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const fallbackKey = Deno.env.get("SERVICE_ROLE_KEY");
  const quoKey = Deno.env.get("QUO_API_KEY");
  if (!url || !key || !quoKey) return json({ error: "Backend configuration unavailable" }, 503);
  if (!token || (token !== key && token !== fallbackKey))
    return json({ error: "Backend credentials required" }, 403);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const inboxes = await resolveQuoPhoneIds({
      apiKey: quoKey,
      configuredIds: Deno.env.get("QUO_PHONE_NUMBER_IDS"),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await backfillQuoMessages(db as unknown as BackfillDb, quoKey, inboxes.ids);
    return json({ mode: "backfill", ...result });
  } catch (error) {
    return json({ error: "Backfill unavailable; retry shortly.", reason: safeAiError(error) }, 503);
  }
}

if (import.meta.main) Deno.serve(handleBackfill);
