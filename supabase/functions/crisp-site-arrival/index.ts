import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { parseSiteArrival, verifySiteArrival } from "../_shared/crisp-site-arrival.ts";

declare const EdgeRuntime: { waitUntil: (task: Promise<unknown>) => void };

// No browser CORS. Only the WordPress server has the per-site signing key.
serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    return new Response("JSON required", { status: 415 });
  if (Number(req.headers.get("content-length")) > 2048)
    return new Response("Payload too large", { status: 413 });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return new Response("Unavailable", { status: 503 });
  try {
    // Bounded stream, including chunked requests without Content-Length.
    const reader = req.body?.getReader();
    if (!reader) return new Response("Invalid arrival", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2048) {
        await reader.cancel();
        return new Response("Payload too large", { status: 413 });
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body = parseSiteArrival(raw);
    if (!body) return new Response("Invalid arrival", { status: 400 });
    const admin = createClient(url, serviceKey);
    const { data: config, error: configError } = await admin.rpc("crisp_get_site_bridge", {
      p_website_id: body.website_id,
    });
    if (configError) throw new Error("Configuration unavailable");
    if (
      !config ||
      req.headers.get("X-JellyBean-Origin") !== config.origin ||
      !(await verifySiteArrival(
        raw,
        req.headers.get("X-JellyBean-Timestamp"),
        req.headers.get("X-JellyBean-Signature"),
        config.key,
      ))
    )
      return new Response("Unauthorized", { status: 401 });
    const { data: result, error } = await admin.rpc("crisp_register_site_arrival", {
      p_website_id: body.website_id,
      p_session_id: body.session_id,
      p_request_id: body.request_id,
    });
    if (error) throw new Error("Receipt unavailable");
    if (result === "limited")
      return new Response("Rate limited", { status: 429, headers: { "Retry-After": "60" } });
    if (result === "disabled") return new Response("Disabled", { status: 403 });
    if (result !== "accepted" && result !== "duplicate")
      throw new Error("Unexpected receipt outcome");
    if (result === "accepted") {
      // Durable pending flag is recoverable by cron if this wake-up fails.
      EdgeRuntime.waitUntil(
        (async () => {
          const response = await fetch(`${url}/functions/v1/crisp-auto-greet`, {
            method: "POST",
            headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ websiteId: body.website_id, greetingsOnly: false }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok || (await response.json()).status !== "ok")
            throw new Error("Worker wake failed");
        })().catch(() => console.error("Site arrival pending recovery", body.website_id)),
      );
    }
    console.info(
      JSON.stringify({ component: "crisp-site-arrival", websiteId: body.website_id, result }),
    );
    return Response.json({ status: result }, { status: result === "accepted" ? 202 : 200 });
  } catch {
    console.error("Site arrival unavailable");
    return new Response("Unavailable", { status: 503 });
  }
});
