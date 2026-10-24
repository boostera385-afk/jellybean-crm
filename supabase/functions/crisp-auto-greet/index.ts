import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { crispFetch, type RpcClient } from "../_shared/crisp-api.ts";
import { mapConcurrent, sendOutcome, timingSafeEqual } from "../_shared/crisp-policy.ts";
import { countCheckDue, readPresence } from "../_shared/crisp-presence.ts";
import { workspaceHeaders } from "../_shared/crisp-worker-credentials.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Admin = RpcClient;

type Workspace = {
  crisp_website_id: string;
  credential_secret_id: string | null;
  crisp_cooldown_until: string | null;
  visitor_count_checked_at: string | null;
  visitor_synced_at: string | null;
  site_presence_pending?: boolean;
};
type Visitor = {
  session_id?: string;
  nickname?: string;
  email?: string;
  avatar?: string;
  useragent?: string;
  initiated?: boolean;
  active?: boolean;
  last_page?: { page_title?: string; page_url?: string };
  geolocation?: {
    country?: string;
    region?: string;
    city?: string;
    coordinates?: { latitude?: number; longitude?: number };
  };
  timezone?: number;
  capabilities?: string[];
  locales?: string[];
};
type Job = {
  id: string;
  lease_token: string;
  crisp_session_id: string;
  content: string;
  created_at: string;
  due_at: string;
};

async function rpc(admin: Admin, name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function reconcile(
  admin: Admin,
  websiteId: string,
  getHeaders: () => Promise<Record<string, string>>,
  workspace: Workspace,
) {
  const token = await rpc(admin, "crisp_claim_presence", { p_website_id: websiteId });
  if (!token) return;
  const headers = await getHeaders();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  // Arrival hints request a one-page identity read, never a full sweep or
  // unverified visitor upsert. Periodic polling still proves absence as before.
  const checkCount =
    !workspace.site_presence_pending && countCheckDue(workspace.visitor_count_checked_at);
  const targets = workspace.site_presence_pending
    ? ((await rpc(admin, "crisp_pending_site_sessions", { p_website_id: websiteId })) as string[])
    : [];
  const snapshot = await readPresence(
    (path) =>
      crispFetch(admin, `https://api.crisp.chat/v1/website/${websiteId}/visitors/${path}`, {
        headers,
      }),
    checkCount,
    targets,
  );
  const applied = await rpc(admin, "crisp_finish_presence_v3", {
    p_website_id: websiteId,
    p_token: token,
    p_started_at: startedAt,
    p_rows: (snapshot.rows as Visitor[]).map((v) => ({
      crisp_session_id: v.session_id,
      nickname: v.nickname,
      email: v.email,
      avatar: v.avatar,
      user_agent: v.useragent,
      initiated: v.initiated,
      active: v.active,
      last_page_title: v.last_page?.page_title,
      last_page_url: v.last_page?.page_url,
      country: v.geolocation?.country,
      region: v.geolocation?.region,
      city: v.geolocation?.city,
      latitude: v.geolocation?.coordinates?.latitude,
      longitude: v.geolocation?.coordinates?.longitude,
      timezone_minutes: v.timezone,
      capabilities: v.capabilities,
      locales: v.locales,
    })),
    p_complete: snapshot.complete,
    p_count: snapshot.count,
    p_active: snapshot.active,
    p_limited: snapshot.limited,
    p_error: snapshot.error,
    p_requests: snapshot.requests,
    p_duration_ms: Math.round(performance.now() - start),
    p_mode: checkCount ? "full" : "identity",
    p_cached: snapshot.cached,
  });
  console.info(
    JSON.stringify({
      component: "crisp-presence",
      websiteId,
      mode: checkCount ? "full" : "identity",
      requests: snapshot.requests,
      rows: snapshot.rows.length,
      complete: snapshot.complete,
      limited: snapshot.limited,
      applied,
      arrivalTargets: targets.length,
      cached: snapshot.cached,
      error: snapshot.error,
      durationMs: Math.round(performance.now() - start),
      claimGapMs: workspace.visitor_synced_at
        ? Date.parse(startedAt) - Date.parse(workspace.visitor_synced_at)
        : null,
    }),
  );
}

async function greet(
  admin: Admin,
  websiteId: string,
  getHeaders: () => Promise<Record<string, string>>,
): Promise<number> {
  const jobs = (await rpc(admin, "crisp_claim_greetings", {
    p_website_id: websiteId,
    p_limit: 2,
  })) as Job[];
  if (!jobs.length) return 0;
  const headers = await getHeaders();
  let sent = 0;
  await mapConcurrent(jobs, 2, async (job) => {
    // Reserve quota BEFORE marking a send as started, so budget failures remain
    // safely retryable. No external call is made before the atomic eligibility check.
    const allowed = await rpc(admin, "crisp_reserve_request", {
      p_website_id: websiteId,
      p_interactive: true,
    });
    if (!allowed) {
      await rpc(admin, "crisp_complete_greeting", {
        p_id: job.id,
        p_token: job.lease_token,
        p_outcome: "retry",
        p_error: "Request budget or cooldown",
      });
      return;
    }
    if (!(await rpc(admin, "crisp_begin_greeting", { p_id: job.id, p_token: job.lease_token })))
      return;
    let status: number | null = null;
    let responseBody: unknown = null;
    const start = performance.now();
    try {
      const response = await fetch(
        `https://api.crisp.chat/v1/website/${websiteId}/conversation/${job.crisp_session_id}/message`,
        {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(8_000),
          body: JSON.stringify({
            type: "text",
            from: "operator",
            origin: "chat",
            content: job.content,
          }),
        },
      );
      status = response.status;
      responseBody = await response.json().catch(() => null);
      if (status === 429 || status === 420)
        await rpc(admin, "crisp_set_cooldown", { p_website_id: websiteId, p_seconds: 60 });
    } catch {
      // Leave the job uncertain: a lost response does not prove a failed send.
    }
    const outcome = sendOutcome(status);
    await rpc(admin, "crisp_complete_greeting", {
      p_id: job.id,
      p_token: job.lease_token,
      p_outcome: outcome,
      p_response: responseBody,
      p_error: outcome === "sent" ? null : `External send ${status ?? "network failure"}`,
    });
    console.info(
      JSON.stringify({
        component: "crisp-greeting",
        websiteId,
        jobId: job.id,
        status,
        outcome,
        durationMs: Math.round(performance.now() - start),
        queuedToOutcomeMs: Date.now() - Date.parse(job.created_at),
        dueToOutcomeMs: Math.max(0, Date.now() - Date.parse(job.due_at)),
      }),
    );
    if (outcome === "sent") sent++;
  });
  return sent;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("Server configuration missing", { status: 500 });
  const admin = createClient(url, key);
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  // Verify against an exact trusted key. The rotation fallback compares against
  // the Vault cron key; it never trusts claims decoded from an unsigned JWT.
  const authorized =
    timingSafeEqual(bearer, key.trim()) ||
    (bearer.length > 0 &&
      (await rpc(admin, "crisp_worker_authorized", { p_token: bearer }).catch(() => false)) ===
        true);
  if (!authorized) return new Response("Unauthorized", { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const websiteId = typeof body.websiteId === "string" ? body.websiteId : null;
    await rpc(admin, "crisp_process_events", { p_website_id: websiteId, p_limit: 50 });
    let query = admin
      .from("crisp_workspaces")
      .select(
        "crisp_website_id,credential_secret_id,crisp_cooldown_until,visitor_count_checked_at,visitor_synced_at,site_presence_pending",
      )
      .eq("enabled", true)
      .order("visitor_synced_at", { ascending: true, nullsFirst: true });
    if (websiteId) query = query.eq("crisp_website_id", websiteId);
    const { data: workspaces, error } = await query;
    if (error) throw error;
    const totals: number[] = [];
    const failures: string[] = [];
    await mapConcurrent((workspaces ?? []) as Workspace[], 3, async (workspace) => {
      try {
        if (!workspace.credential_secret_id) throw new Error("Workspace credentials missing");
        // Idle ticks must not decrypt credentials. Resolve at most once, only
        // after a greeting or presence lease actually needs an external call.
        const getHeaders = workspaceHeaders(admin, workspace.credential_secret_id);
        // Event-derived presence must be greeted without waiting for REST polling.
        totals.push(await greet(admin, workspace.crisp_website_id, getHeaders));
        if (
          body.greetingsOnly !== true &&
          (!workspace.crisp_cooldown_until ||
            Date.parse(workspace.crisp_cooldown_until) <= Date.now())
        ) {
          await reconcile(admin, workspace.crisp_website_id, getHeaders, workspace);
          totals.push(await greet(admin, workspace.crisp_website_id, getHeaders));
        }
      } catch (error) {
        failures.push(workspace.crisp_website_id);
        console.error(
          "Crisp worker workspace failed",
          workspace.crisp_website_id,
          error instanceof Error ? error.message : "unknown",
        );
      }
    });
    return Response.json(
      {
        status: failures.length ? "partial" : "ok",
        greeted: totals.reduce((sum, n) => sum + n, 0),
        failedWorkspaces: failures,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    console.error("Crisp worker failed", error instanceof Error ? error.message : "unknown");
    return Response.json(
      { error: "Worker processing failed" },
      { status: 500, headers: corsHeaders },
    );
  }
});
