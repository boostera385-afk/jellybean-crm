import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { eventFingerprint, timingSafeEqual } from "../_shared/crisp-policy.ts";

declare const EdgeRuntime: { waitUntil: (task: Promise<unknown>) => void };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const receivedAt = performance.now();
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) throw new Error("Server configuration missing");
    const providedKey = new URL(req.url).searchParams.get("key");
    if (!providedKey) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const raw = await req.text();
    if (raw.length > 256_000) return new Response("Payload too large", { status: 413 });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
      if (!body || Array.isArray(body) || typeof body !== "object")
        throw new Error("Invalid payload");
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const data = body.data as Record<string, unknown> | undefined;
    const websiteId = body.website_id ?? data?.website_id;
    if (typeof websiteId !== "string" || typeof body.event !== "string")
      return new Response("Invalid event", { status: 400 });
    const admin = createClient(url, serviceKey);
    const { data: workspace, error: workspaceError } = await admin
      .from("crisp_workspaces")
      .select("enabled,credential_secret_id")
      .eq("crisp_website_id", websiteId)
      .maybeSingle();
    if (workspaceError) throw workspaceError;
    if (!workspace?.enabled || !workspace.credential_secret_id)
      return new Response("Unauthorized", { status: 401 });
    const { data: secret, error: secretError } = await admin.rpc("crisp_get_workspace_secret", {
      p_secret_id: workspace.credential_secret_id,
    });
    if (secretError) throw secretError;
    const expectedKey = secret?.webhook_secret ?? secret?.webhookSecret;
    if (typeof expectedKey !== "string" || !timingSafeEqual(providedKey, expectedKey))
      return new Response("Unauthorized", { status: 401 });
    const { data: eventId, error: insertError } = await admin.rpc("crisp_accept_event", {
      p_body: body,
      p_fingerprint: await eventFingerprint(body),
    });
    if (insertError) throw insertError;
    // Durable storage is already committed. Background dispatch is an accelerator;
    // cron independently processes pending records if this invocation is lost.
    EdgeRuntime.waitUntil(
      (async () => {
        const { error } = await admin.rpc("crisp_process_events", {
          p_website_id: websiteId,
          p_limit: 20,
        });
        if (error) throw error;
        const response = await fetch(`${url}/functions/v1/crisp-auto-greet`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ websiteId, greetingsOnly: true }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Worker wake-up HTTP ${response.status}`);
      })().catch((error) =>
        console.error(
          "Crisp event remains recoverable",
          eventId,
          error instanceof Error ? error.message : "unknown",
        ),
      ),
    );
    console.info(
      JSON.stringify({
        component: "crisp-webhook",
        eventId,
        websiteId,
        event: body.event,
        durableReceiptMs: Math.round(performance.now() - receivedAt),
      }),
    );
    return Response.json({ status: "accepted", event_id: eventId }, { headers: corsHeaders });
  } catch (error) {
    // Never log req.url: it contains the webhook secret.
    console.error("Crisp receipt failed", error instanceof Error ? error.message : "unknown");
    return Response.json(
      { error: "Event storage unavailable" },
      { status: 500, headers: corsHeaders },
    );
  }
});
