import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  composeAnswerAware,
  renderComposePlan,
  safeComposerError,
  scoreComposeReply,
  CS_COMPOSER_MODEL,
  CS_COMPOSER_VERSION,
  type ComposerInput,
} from "../_shared/cs-composer.ts";
import { senderForTick, fallbackTick } from "../_shared/cs-compose-senders.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const roles = [
  "admin",
  "sub_admin",
  "cs_admin",
  "cs",
  "scraping",
  "maturing",
  "acc_handler",
  "facebook",
  "seo",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function handleCompose(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token || token === authorization) return json({ error: "Sign in required" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!url || !serviceKey || !anonKey || !apiKey)
    return json({ error: "Composer configuration missing" }, 503);
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const isService = token === serviceKey;
  const userDb = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 16_000) return json({ error: "Request too large" }, 413);
    body = JSON.parse(raw);
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (body.action === "evaluate") {
    // A management-only, one-use database ticket is the authentication for a
    // QA job. Caller cannot provide prompts/cases or select production leads.
    // Keep this header OUT of CORS allow-headers: never a browser feature.
    const ticket = req.headers.get("x-compose-eval-ticket") ?? "";
    if (
      typeof body.jobId !== "string" ||
      !uuid.test(body.jobId) ||
      ticket.length < 32 ||
      ticket.length > 200
    ) {
      return json({ error: "Valid scoped evaluation ticket required" }, 403);
    }
    const { data: cases, error: claimError } = await admin.rpc("cs_claim_compose_eval", {
      p_job_id: body.jobId,
      p_token: ticket,
    });
    if (claimError || !Array.isArray(cases))
      return json({ error: "Evaluation ticket invalid, expired or consumed" }, 403);
    try {
      const results: unknown[] = [];
      // Bounded fan-out and a hard DB limit of 12 fixtures per administrator job.
      for (let start = 0; start < cases.length; start += 3) {
        const batch = await Promise.all(
          cases.slice(start, start + 3).map(async (test) => {
            if (!test.input || JSON.stringify(test.input).length > 8000)
              throw new Error("Invalid evaluation fixture");
            const result = await composeAnswerAware(test.input, { apiKey });
            const message = renderComposePlan(test.input, result.plan, "Alex");
            const keys = result.plan.questions.map((q) => q.key);
            return {
              name: test.name,
              rephrased: message,
              questionKeys: keys,
              warnings: result.warnings,
              ...scoreComposeReply(test, message, keys),
              model: result.model,
              version: result.version,
            };
          }),
        );
        results.push(...batch);
      }
      const { error: saveError } = await admin
        .from("cs_compose_eval_jobs")
        .update({
          status: "done",
          results,
          completed_at: new Date().toISOString(),
        })
        .eq("id", body.jobId);
      if (saveError) throw new Error("Evaluation result persistence failed");
      return json({ jobId: body.jobId, status: "done", count: results.length });
    } catch (error) {
      await admin
        .from("cs_compose_eval_jobs")
        .update({
          status: "failed",
          results: { error: safeComposerError(error) },
          completed_at: new Date().toISOString(),
        })
        .eq("id", body.jobId);
      return json({ error: "Evaluation failed", jobId: body.jobId }, 502);
    }
  }
  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  if (!uuid.test(leadId)) return json({ error: "Valid leadId required" }, 400);
  let actorId: string;
  if (isService) {
    // Only a trusted backend may forward an actor. Browser-supplied actorId
    // is NEVER used when authenticating an ordinary user token.
    if (typeof body.actorId !== "string" || !uuid.test(body.actorId))
      return json({ error: "Actor required" }, 403);
    actorId = body.actorId;
  } else {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return json({ error: "Invalid or expired session" }, 401);
    actorId = data.user.id;
  }
  const { data: userRoles, error: roleError } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", actorId)
    .in("role", roles);
  if (roleError) return json({ error: "Could not verify permissions" }, 503);
  if (!userRoles?.length) return json({ error: "CS compose access required" }, 403);

  // JWT user's RLS controls record access. Trusted backend calls have already
  // checked that same user's access before forwarding the service request.
  const { data: lead, error: leadError } = await (isService ? admin : userDb)
    .from("qualified_leads")
    .select(
      "id, customer_name, post_text, context, service, main_area, sub_area, cs_notes, images, requirement_1, requirement_2, marketing_notes, reference",
    )
    .eq("id", leadId)
    .maybeSingle();
  if (leadError || !lead) return json({ error: "Lead unavailable or access denied" }, 404);

  const { data: runId, error: reserveError } = await admin.rpc("cs_reserve_compose_run", {
    p_actor_id: actorId,
    p_lead_id: leadId,
    p_model: CS_COMPOSER_MODEL,
    p_version: CS_COMPOSER_VERSION,
  });
  if (reserveError || !runId)
    return json({ error: "Compose limit reached or audit unavailable. Try again shortly." }, 429);
  const started = performance.now();
  try {
    const notes = Array.isArray(lead.cs_notes)
      ? lead.cs_notes
          .filter((n: unknown): n is { text: string } =>
            Boolean(n && typeof n === "object" && "text" in n && typeof n.text === "string"),
          )
          .map((n: { text: string }) => n.text)
      : [];
    const input: ComposerInput = {
      customerName: lead.customer_name || "there",
      postText: lead.post_text,
      context: lead.context,
      service: lead.service,
      mainArea: lead.main_area,
      subArea: lead.sub_area,
      notes,
      imageCount: Array.isArray(lead.images) ? lead.images.length : 0,
      suggestedRequirements: [lead.requirement_1, lead.requirement_2].filter(Boolean),
      previousDraft: lead.marketing_notes,
      // Only used to pick the opening; never read as a customer answer.
      reference: lead.reference,
    };
    // Refuse oversize input instead of silently truncating away already-known
    // facts and then asking the customer for the facts we just discarded.
    if (JSON.stringify(input).length > 55_000)
      throw new Error("Lead context too long for safe composition");
    const { data: preferences, error: preferenceError } = await admin
      .from("shared_state")
      .select("value")
      .eq("key", "cs_rephrase_prompt")
      .maybeSingle();
    if (preferenceError) throw new Error("Could not load style preferences");
    const pref = preferences?.value;
    const stylePreferences =
      pref?.policyVersion === CS_COMPOSER_VERSION && typeof pref.text === "string"
        ? pref.text.slice(0, 2000)
        : "";
    const result = await composeAnswerAware(input, { apiKey, stylePreferences });
    const { data: tick, error: tickError } = await admin.rpc("cs_next_compose_sender_tick");
    const sender = senderForTick(!tickError && tick !== null ? Number(tick) : fallbackTick());
    const rephrased = renderComposePlan(input, result.plan, sender);
    const { error: auditError } = await admin
      .from("cs_compose_runs")
      .update({
        outcome: "success",
        duration_ms: Math.round(performance.now() - started),
        question_keys: result.plan.questions.map((q) => q.key),
        warnings: result.warnings,
      })
      .eq("id", runId);
    if (auditError) throw new Error("Could not record compose result");
    // Draft only. Saving is an explicit existing UI action; never send a
    // message or overwrite saved notes merely by generating/evaluating one.
    console.log(
      JSON.stringify({
        event: "cs_compose",
        runId,
        version: result.version,
        model: result.model,
        questions: result.plan.questions.length,
        warnings: result.warnings,
      }),
    );
    return json({
      rephrased,
      runId,
      model: result.model,
      version: result.version,
      warnings: result.warnings,
      questionKeys: result.plan.questions.map((q) => q.key),
    });
  } catch (error) {
    await admin
      .from("cs_compose_runs")
      .update({
        outcome: "failed",
        duration_ms: Math.round(performance.now() - started),
        warnings: [safeComposerError(error)],
      })
      .eq("id", runId);
    // No customer text, raw provider error, token or full prompt is logged.
    console.error(
      JSON.stringify({ event: "cs_compose_failed", runId, version: CS_COMPOSER_VERSION }),
    );
    return json(
      {
        error: "Could not safely compose a reply. Your existing draft has not been changed.",
        runId,
      },
      502,
    );
  }
}

Deno.serve(handleCompose);
