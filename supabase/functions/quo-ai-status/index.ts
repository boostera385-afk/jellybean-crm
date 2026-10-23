import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  AI_STATUS_VERSION,
  isQuoConfigurationProbe,
  isQuoWorker,
  resolveQuoPhoneIds,
  safeAiError,
} from "../_shared/quo-ai-status.ts";
import { processQuoJob, type QuoWorkerDb } from "../_shared/quo-worker.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleAiStatus(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "Sign in required" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Backend configuration unavailable" }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const quoKey = Deno.env.get("QUO_API_KEY");
  const modelKey = Deno.env.get("OPENAI_API_KEY");
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 2048) return json({ error: "Request too large" }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  // Exact backend credentials can probe config or resume already-enqueued work.
  // They cannot enqueue new leads or choose an arbitrary actor through HTTP.
  let actorId: string | null = null;
  const fallbackKey = Deno.env.get("SERVICE_ROLE_KEY") ?? "";
  const isWorker =
    isQuoWorker(token, key, body.action) || isQuoWorker(token, fallbackKey, body.action);
  if (
    !isQuoConfigurationProbe(token, key, body.action) &&
    !isQuoConfigurationProbe(token, fallbackKey, body.action) &&
    !isWorker
  ) {
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "Invalid or expired session" }, 401);
    const { data: roles, error: roleError } = await db
      .from("user_roles")
      .select("role")
      .eq("user_id", auth.user.id)
      .in("role", ["admin", "sub_admin", "cs_admin"]);
    if (roleError) return json({ error: "Could not verify permissions" }, 503);
    if (!roles?.length) return json({ error: "AI reporting access required" }, 403);
    actorId = auth.user.id;
  }
  if (!["configuration", "refresh", "work", "enqueue"].includes(String(body.action)))
    return json({ error: "Invalid action" }, 400);
  // The unattended sweep picks its own leads, with no date range and nobody to
  // attribute it to, so it stays the cron's alone. A signed-in administrator
  // asking for the same thing has "refresh", which records who asked.
  if (body.action === "enqueue" && !isWorker)
    return json({ error: "Backend credentials required" }, 403);
  if (!quoKey || !modelKey)
    return json(
      {
        message:
          "Set QUO_API_KEY and OPENAI_API_KEY in this project's Edge Function secrets. Quo inbox IDs are discovered automatically.",
        missingSecrets: [!quoKey && "QUO_API_KEY", !modelKey && "OPENAI_API_KEY"].filter(Boolean),
        configured: false,
      },
      body.action === "configuration" ? 200 : 503,
    );
  for (const name of ["from", "to"])
    if (
      body[name] != null &&
      (typeof body[name] !== "string" || !Number.isFinite(Date.parse(body[name] as string)))
    )
      return json({ error: "Invalid date range" }, 400);
  if (body.leadId != null && (typeof body.leadId !== "string" || !uuid.test(body.leadId)))
    return json({ error: "Invalid lead ID" }, 400);
  if (body.from && body.to && Date.parse(body.from as string) >= Date.parse(body.to as string))
    return json({ error: "Invalid date range" }, 400);
  if (body.action === "work") {
    try {
      return json({
        mode: "shadow",
        ...(await processQuoJob(db as unknown as QuoWorkerDb, quoKey, modelKey)),
      });
    } catch {
      return json({ error: "Queued worker unavailable; retry shortly." }, 503);
    }
  }
  let inboxes: { ids: string[]; source: "configured" | "discovered" };
  try {
    inboxes = await resolveQuoPhoneIds({
      apiKey: quoKey,
      configuredIds: Deno.env.get("QUO_PHONE_NUMBER_IDS"),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return json(
      {
        configured: false,
        reasonCode: safeAiError(error),
        message:
          "Quo inbox discovery failed. Check the REST API key and its account access; phone-number IDs do not need manual entry.",
      },
      body.action === "configuration" ? 200 : 503,
    );
  }
  if (body.action === "configuration")
    return json({
      configured: true,
      mode: "shadow",
      batchSize: 5,
      phoneNumberCount: inboxes.ids.length,
      phoneNumberSource: inboxes.source,
      // IDs are account metadata, not customer phone numbers. Needed only by
      // a trusted management probe to enqueue an explicitly audited smoke test.
      phoneNumberIds:
        isQuoConfigurationProbe(token, key, body.action) ||
        isQuoConfigurationProbe(token, Deno.env.get("SERVICE_ROLE_KEY") ?? "", body.action)
          ? inboxes.ids
          : undefined,
    });
  if (body.action === "enqueue") {
    // Demand-driven: enqueue_quo_ai_due queues only leads with a reason to be
    // looked at -- an event, never classified, an unconfirmed delivery, an
    // edited lead -- and leaves the last fifth of the daily budget for a
    // person pressing Refresh. A lead nothing happened to is not queued, which
    // is the whole saving over re-scanning the catalogue in rotation.
    const { data: queued, error: sweepError } = await db.rpc("enqueue_quo_ai_due", {
      p_inbox_ids: inboxes.ids,
      p_limit: 5,
      // Results from an older rule set are re-read so every lead in scope ends
      // up classified by the current rules.
      p_policy_version: AI_STATUS_VERSION,
    });
    if (sweepError || typeof queued !== "number")
      return json({ error: "Could not reserve analysis batch" }, 503);
    return json({ mode: "shadow", queued, inboxes: inboxes.ids.length });
  }
  if (!actorId) return json({ error: "User identity required for refresh" }, 403);
  const { data: queued, error: claimError } = await db.rpc("enqueue_quo_ai_batch", {
    p_actor_id: actorId,
    p_inbox_ids: inboxes.ids,
    p_from: body.from ?? null,
    p_to: body.to ?? null,
    p_lead_id: body.leadId ?? null,
  });
  if (claimError || typeof queued !== "number")
    return json({ error: "Could not reserve analysis batch" }, 503);
  return json({
    mode: "shadow",
    queued,
    processed: 0,
    results: [],
    message: queued
      ? `${queued} leads queued across ${inboxes.ids.length} inboxes. Background sync will resume automatically.`
      : "No eligible leads, batch active, or beta limit reached. Retry later.",
  });
}

if (import.meta.main) Deno.serve(handleAiStatus);
