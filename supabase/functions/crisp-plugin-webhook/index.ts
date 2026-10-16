import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { eventFingerprint } from "../_shared/crisp-policy.ts";
import { processAndWake, verifyPluginHook } from "../_shared/crisp-hooks.ts";

declare const EdgeRuntime: { waitUntil: (task: Promise<unknown>) => void };

// Separate endpoint: there is deliberately NO unsigned-key fallback here.
// Activation requires Crisp Marketplace approval/installation, the hook's
// CRISP_PLUGIN_SIGNING_SECRET in Edge secrets, and an explicitly opted-in
// workspace (presence_feed='plugin'). Do not opt in on configuration alone:
// verify signed silent-visitor availability events in a one-workspace canary.
// Keep REST recovery enabled; webhook silence is not a connection heartbeat.
serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const started = performance.now();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("Plugin feed not configured", { status: 503 });
  const admin = createClient(url, key);
  // Edge-env secret wins; fall back to the vault copy so rotation needs no
  // redeploy. Both empty => fail closed.
  let secret = Deno.env.get("CRISP_PLUGIN_SIGNING_SECRET");
  if (!secret) {
    const { data: vaultSecret, error: vaultError } = await admin.rpc(
      "crisp_read_plugin_signing_secret",
    );
    if (vaultError) throw new Error("Plugin secret lookup failed");
    if (typeof vaultSecret === "string" && vaultSecret) secret = vaultSecret;
  }
  if (!secret) return new Response("Plugin feed not configured", { status: 503 });
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > 256_000)
      return new Response("Payload too large", { status: 413 });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (
      !(await verifyPluginHook(
        body,
        req.headers.get("X-Crisp-Request-Timestamp"),
        req.headers.get("X-Crisp-Signature"),
        secret,
      ))
    )
      return new Response("Unauthorized", { status: 401 });
    const data = body.data as Record<string, unknown> | undefined;
    const websiteId = body.website_id ?? data?.website_id;
    if (
      typeof websiteId !== "string" ||
      typeof body.event !== "string" ||
      (data?.website_id !== undefined && data.website_id !== websiteId)
    )
      return new Response("Invalid event", { status: 400 });
    // Subscribe only to these namespaces in Marketplace. Existing Website Hooks
    // continue handling messages; presence does not need duplicated message feeds.
    if (!["session:update_availability", "website:update_visitors_count"].includes(body.event))
      return new Response("Event not enabled", { status: 400 });
    if (body.event === "session:update_availability") {
      const availability =
        typeof data?.availability === "string"
          ? data.availability
          : ((data?.availability as Record<string, unknown> | undefined)?.type ??
            (data?.availability as Record<string, unknown> | undefined)?.status);
      if (
        typeof data?.session_id !== "string" ||
        !data.session_id.trim() ||
        !["online", "offline"].includes(String(availability))
      )
        return new Response("Invalid presence", { status: 400 });
    }
    const { data: workspace, error } = await admin
      .from("crisp_workspaces")
      .select("enabled,presence_feed")
      .eq("crisp_website_id", websiteId)
      .maybeSingle();
    if (error) throw new Error("Workspace lookup failed");
    if (!workspace?.enabled || workspace.presence_feed !== "plugin")
      return new Response("Workspace feed not enabled", { status: 403 });
    const fingerprint = await eventFingerprint(body);
    const { data: eventId, error: receiptError } = await admin.rpc("crisp_accept_event", {
      p_body: { ...body, source: "plugin" },
      p_fingerprint: fingerprint,
    });
    if (receiptError) throw new Error("Event storage failed");
    EdgeRuntime.waitUntil(
      processAndWake(
        admin,
        url,
        key,
        websiteId,
        body.event === "session:update_availability",
        String(eventId),
      ).catch(() => console.error("Crisp plugin event remains recoverable", eventId)),
    );
    console.info(
      JSON.stringify({
        component: "crisp-plugin-hook",
        eventId,
        websiteId,
        event: body.event,
        durableReceiptMs: Math.round(performance.now() - started),
      }),
    );
    return Response.json({ status: "accepted", event_id: eventId });
  } catch {
    console.error("Crisp plugin receipt failed");
    return Response.json({ error: "Event storage unavailable" }, { status: 500 });
  }
});
