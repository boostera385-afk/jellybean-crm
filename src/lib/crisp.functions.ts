import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { crispFetch } from "../../supabase/functions/_shared/crisp-api";

const CRISP_ROLES = ["admin", "cs_admin", "cs"];
const CRISP_VISITOR_TIME_ZONE = "Asia/Karachi";
// Only the columns mapVisitor actually returns. `select("*")` also ships the id,
// bookkeeping timestamps and greeting markers that the UI never reads.
const VISITOR_COLUMNS = [
  "crisp_website_id",
  "crisp_session_id",
  "nickname",
  "email",
  "avatar",
  "user_agent",
  "initiated",
  "active",
  "is_online",
  "last_page_title",
  "last_page_url",
  "country",
  "region",
  "city",
  "latitude",
  "longitude",
  "timezone_minutes",
  "capabilities",
  "locales",
  "first_seen_at",
  "last_seen_at",
].join(",");
// Today's list is a scrollable rail, so it does not need every row: unbounded it
// grows all day and is re-read on every presence change. The displayed total
// comes from a separate exact count, so capping the list does not skew it.
const TODAY_VISITOR_LIMIT = 200;

export type CrispVisitor = {
  crisp_website_id: string;
  workspace_name: string | null;
  crisp_session_id: string;
  nickname: string | null;
  email: string | null;
  avatar: string | null;
  user_agent: string | null;
  initiated: boolean;
  active: boolean;
  is_online: boolean;
  last_page_title: string | null;
  last_page_url: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone_minutes: number | null;
  capabilities: string[];
  locales: string[];
  first_seen_at: string;
  last_seen_at: string;
};

export type CrispVisitorOverview = {
  ok: boolean;
  liveVisitors: CrispVisitor[];
  todayVisitors: CrispVisitor[];
  liveCount: number;
  activeCount: number;
  todayCount: number;
  limited: boolean;
  fetchedAt: string;
  presenceMode?: "polling" | "plugin" | "mixed";
  errors?: string[];
  error?: string;
};

type CrispWorkspaceRow = {
  crisp_website_id: string;
  workspace_name: string;
  credential_secret_id: string;
  live_visitor_count: number;
  active_visitor_count: number;
  visitors_limited: boolean;
  visitor_sync_succeeded_at: string | null;
  visitor_sync_error: string | null;
  visitor_identity_checked_at: string | null;
  visitor_count_checked_at: string | null;
  visitor_effective_interval_seconds: number;
  visitor_budget_used: number;
  crisp_request_limit: number;
  crisp_interactive_reserve: number;
  presence_feed: "polling" | "plugin";
};

// Generated types lag behind the live-visitor migration, so the row is declared here.
type CrispVisitorRow = {
  crisp_website_id: string;
  crisp_session_id: string;
  nickname: string | null;
  email: string | null;
  avatar: string | null;
  user_agent: string | null;
  initiated: boolean;
  active: boolean;
  is_online: boolean;
  last_page_title: string | null;
  last_page_url: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone_minutes: number | null;
  capabilities: string[];
  locales: string[];
  first_seen_at: string;
  last_seen_at: string;
  last_online_at: string | null;
};

function pakistanDayKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CRISP_VISITOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function pakistanDayStartIso(date: Date) {
  const day = pakistanDayKey(date);
  return new Date(`${day}T00:00:00+05:00`).toISOString();
}

/**
 * Minimal structural shape required by the role guards below.
 *
 * Deliberately shallow, with `unknown` leaves: giving these helpers a precise
 * client shape makes TypeScript structurally compare it against
 * `SupabaseClient<Database>`, which forces instantiation of the entire
 * generated schema and exhausts the compiler's instantiation depth (TS2589
 * "type instantiation is excessively deep"). Only `user_roles` is read, so the
 * result is narrowed explicitly at the single call site instead.
 */
type RoleQueryClient = {
  from: (table: string) => {
    select: (columns?: string) => {
      eq: (column: string, value: unknown) => PromiseLike<unknown>;
    };
  };
};

type RoleQueryResult = { data: { role: string }[] | null; error: Error | null };

/** Read the caller's `user_roles` rows. Shared by {@link assertCrispAccess} and {@link assertAdmin}. */
async function fetchCallerRoles(client: unknown, userId: string): Promise<RoleQueryResult> {
  const supabase = client as RoleQueryClient;
  const result = await supabase.from("user_roles").select("role").eq("user_id", userId);
  return (result ?? {}) as RoleQueryResult;
}

/**
 * Rejects callers without a Crisp-capable role.
 *
 * `client` is typed `unknown` so that accepting it costs no structural
 * comparison at all; the single cast above is the only place the shape is
 * asserted.
 */
async function assertCrispAccess(client: unknown, userId: string) {
  const { data: roleRows, error: roleErr } = await fetchCallerRoles(client, userId);
  if (roleErr) throw new Error("Could not verify user roles");
  const roles = (roleRows ?? []).map((r: { role: string }) => String(r.role));
  if (!roles.some((r: string) => CRISP_ROLES.includes(r))) {
    throw new Error("Forbidden: Crisp Chat is restricted to admin, cs_admin and cs roles.");
  }
}

export const syncCrispHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { websiteId?: string }) => {
    const websiteId = input?.websiteId ? String(input.websiteId).trim() : undefined;
    return { websiteId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCrispAccess(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { syncWorkspace } = await import("./crisp.server");

    let query = supabaseAdmin
      .from("crisp_workspaces")
      .select("id, crisp_website_id, workspace_name, credential_secret_id, enabled")
      .eq("enabled", true);
    if (data.websiteId) query = query.eq("crisp_website_id", data.websiteId);

    const { data: workspaces, error: wsErr } = await query;
    if (wsErr)
      return { ok: false as const, error: `Could not load Crisp workspaces: ${wsErr.message}` };
    if (!workspaces || workspaces.length === 0) {
      return { ok: false as const, error: "No enabled Crisp workspace is configured yet." };
    }

    let syncedConversations = 0;
    let syncedMessages = 0;
    const errors: string[] = [];

    for (const ws of workspaces) {
      try {
        const res = await syncWorkspace(supabaseAdmin as never, ws as never, { maxPages: 3 });
        syncedConversations += res.conversations;
        syncedMessages += res.messages;
        if (res.error) errors.push(`${ws.workspace_name || ws.crisp_website_id}: ${res.error}`);
      } catch (err) {
        errors.push(
          `${ws.workspace_name || ws.crisp_website_id}: ${err instanceof Error ? err.message : "Sync failed"}`,
        );
      }
    }

    if (syncedConversations === 0 && errors.length > 0) {
      return { ok: false as const, error: errors.join(" | ") };
    }

    return {
      ok: true as const,
      synced_conversations: syncedConversations,
      synced_messages: syncedMessages,
      errors: errors.length > 0 ? errors : undefined,
    };
  });

export const getCrispVisitorOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { websiteId?: string }) => ({
    websiteId: input?.websiteId ? String(input.websiteId).trim() : undefined,
  }))
  .handler(async ({ data, context }): Promise<CrispVisitorOverview> => {
    const { supabase, userId } = context;
    await assertCrispAccess(supabase, userId);

    const { supabaseAdmin: typedAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabaseAdmin = typedAdmin as any; // generated types lag behind the live-visitor migration
    const now = new Date();
    const nowIso = now.toISOString();

    let workspaceQuery = supabaseAdmin
      .from("crisp_workspaces")
      .select(
        "crisp_website_id, workspace_name, live_visitor_count, active_visitor_count, visitors_limited, visitor_sync_succeeded_at, visitor_sync_error, visitor_identity_checked_at, visitor_count_checked_at, visitor_effective_interval_seconds, visitor_budget_used, crisp_request_limit, crisp_interactive_reserve, presence_feed",
      )
      .eq("enabled", true);
    if (data.websiteId) workspaceQuery = workspaceQuery.eq("crisp_website_id", data.websiteId);

    const { data: workspaces, error: workspaceError } = await workspaceQuery;
    if (workspaceError) {
      return {
        ok: false,
        liveVisitors: [],
        todayVisitors: [],
        liveCount: 0,
        activeCount: 0,
        todayCount: 0,
        limited: false,
        fetchedAt: nowIso,
        error: `Could not load Crisp workspaces: ${workspaceError.message}`,
      };
    }

    const workspaceNames = new Map<string, string>(
      (workspaces ?? []).map((workspace: CrispWorkspaceRow) => [
        workspace.crisp_website_id,
        workspace.workspace_name,
      ]),
    );
    const errors: string[] = [];
    let reportedLiveCount = 0;
    let reportedActiveCount = 0;
    let limited = false;

    // Reads never synchronize or send greetings. The durable worker owns those
    // side effects, independently of operator tabs and overview refreshes.
    for (const workspace of (workspaces ?? []) as CrispWorkspaceRow[]) {
      reportedLiveCount += workspace.live_visitor_count;
      reportedActiveCount += workspace.active_visitor_count;
      limited ||= workspace.visitors_limited;
      if (workspace.visitor_sync_error) {
        errors.push(`${workspace.workspace_name}: ${workspace.visitor_sync_error}`);
      } else if (
        !workspace.visitor_identity_checked_at ||
        now.getTime() - new Date(workspace.visitor_identity_checked_at).getTime() >
          Math.max(30_000, workspace.visitor_effective_interval_seconds * 2_000 + 10_000)
      ) {
        errors.push(`${workspace.workspace_name}: visitor identity checks are delayed`);
      }
      if (workspace.visitors_limited)
        errors.push(`${workspace.workspace_name}: Crisp visitor results are limited`);
      if (
        !workspace.visitor_sync_error &&
        (!workspace.visitor_sync_succeeded_at ||
          now.getTime() - new Date(workspace.visitor_sync_succeeded_at).getTime() >
            Math.max(90_000, workspace.visitor_effective_interval_seconds * 5_000))
      )
        errors.push(`${workspace.workspace_name}: full presence reconciliation is delayed`);
      if (
        workspace.visitor_budget_used >=
        (workspace.crisp_request_limit - workspace.crisp_interactive_reserve) * 0.8
      )
        errors.push(
          `${workspace.workspace_name}: background polling slowed to protect the request budget`,
        );
    }
    const websiteIds = (workspaces ?? []).map((w: CrispWorkspaceRow) => w.crisp_website_id);
    const todayStartIso = pakistanDayStartIso(now);

    const mapVisitor = (visitor: CrispVisitorRow): CrispVisitor => ({
      crisp_website_id: visitor.crisp_website_id,
      workspace_name: workspaceNames.get(visitor.crisp_website_id) ?? null,
      crisp_session_id: visitor.crisp_session_id,
      nickname: visitor.nickname,
      email: visitor.email,
      avatar: visitor.avatar,
      user_agent: visitor.user_agent,
      initiated: visitor.initiated,
      active: visitor.active,
      is_online: visitor.is_online,
      last_page_title: visitor.last_page_title,
      last_page_url: visitor.last_page_url,
      country: visitor.country,
      region: visitor.region,
      city: visitor.city,
      latitude: visitor.latitude,
      longitude: visitor.longitude,
      timezone_minutes: visitor.timezone_minutes,
      capabilities: visitor.capabilities,
      locales: visitor.locales,
      first_seen_at: visitor.first_seen_at,
      last_seen_at: visitor.last_seen_at,
    });

    let liveQuery = supabaseAdmin
      .from("crisp_visitors")
      .select(VISITOR_COLUMNS)
      .in("crisp_website_id", websiteIds)
      .eq("is_online", true)
      .order("active", { ascending: false })
      .order("last_seen_at", { ascending: false });
    if (data.websiteId) liveQuery = liveQuery.eq("crisp_website_id", data.websiteId);

    let todayQuery = supabaseAdmin
      .from("crisp_visitors")
      .select(VISITOR_COLUMNS)
      .in("crisp_website_id", websiteIds)
      .gte("last_seen_at", todayStartIso)
      .order("last_seen_at", { ascending: false })
      .limit(TODAY_VISITOR_LIMIT);
    if (data.websiteId) todayQuery = todayQuery.eq("crisp_website_id", data.websiteId);

    // head:true returns the count without shipping any rows, so the total stays
    // exact even though the list above is capped.
    let todayCountQuery = supabaseAdmin
      .from("crisp_visitors")
      .select("crisp_session_id", { count: "exact", head: true })
      .in("crisp_website_id", websiteIds)
      .gte("last_seen_at", todayStartIso);
    if (data.websiteId) todayCountQuery = todayCountQuery.eq("crisp_website_id", data.websiteId);

    // These three reads are independent, so one round trip instead of three.
    // Presence refreshes run on every realtime change; the serial version made
    // each one as slow as the sum of its queries.
    const [liveResult, todayResult, todayCountResult] = await Promise.all([
      liveQuery,
      todayQuery,
      todayCountQuery,
    ]);
    const { data: liveRows, error: liveError } = liveResult;
    const { data: todayRows, error: todayError } = todayResult;
    if (liveError) errors.push(`Live visitor details are unavailable: ${liveError.message}`);
    if (todayError) {
      errors.push(`Today's visitor details are unavailable: ${todayError.message}`);
    }

    const liveVisitors = (liveRows ?? []).map(mapVisitor);
    const todayVisitors: CrispVisitor[] = (todayRows ?? []).map(mapVisitor);
    // Fall back to the capped list length only if the count read failed.
    const todayCount =
      typeof todayCountResult?.count === "number" ? todayCountResult.count : todayVisitors.length;

    return {
      ok: errors.length === 0 || liveVisitors.length > 0 || todayVisitors.length > 0,
      liveVisitors,
      todayVisitors,
      liveCount: Math.max(reportedLiveCount, liveVisitors.length),
      activeCount: Math.max(
        reportedActiveCount,
        liveVisitors.filter((visitor: CrispVisitor) => visitor.active).length,
      ),
      todayCount,
      limited,
      fetchedAt: nowIso,
      presenceMode: (workspaces ?? []).every((w: CrispWorkspaceRow) => w.presence_feed === "plugin")
        ? "plugin"
        : (workspaces ?? []).some((w: CrispWorkspaceRow) => w.presence_feed === "plugin")
          ? "mixed"
          : "polling",
      errors: errors.length > 0 ? errors : undefined,
      error:
        errors.length > 0 && liveVisitors.length === 0 && todayVisitors.length === 0
          ? errors.join(" | ")
          : undefined,
    };
  });

export const sendCrispMessageToVisitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { websiteId: string; sessionId: string; content: string }) => {
    const websiteId = String(input?.websiteId ?? "").trim();
    const sessionId = String(input?.sessionId ?? "").trim();
    const content = String(input?.content ?? "").trim();
    if (!websiteId || !sessionId || !content) {
      throw new Error("websiteId, sessionId and non-empty content are required");
    }
    return { websiteId, sessionId, content };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCrispAccess(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getWorkspaceCreds, crispHeaders, crispErrorReason } = await import("./crisp.server");
    const { data: workspace } = await supabaseAdmin
      .from("crisp_workspaces")
      .select("credential_secret_id, enabled")
      .eq("crisp_website_id", data.websiteId)
      .maybeSingle();
    if (!workspace?.enabled || !workspace.credential_secret_id) {
      return { ok: false as const, error: "Workspace is missing, disabled or not configured." };
    }

    const credsResult = await getWorkspaceCreds(
      supabaseAdmin as never,
      workspace.credential_secret_id,
    );
    if (!credsResult.ok) return { ok: false as const, error: credsResult.error };

    const sendStarted = performance.now();
    const response = await crispFetch(
      supabaseAdmin as never,
      `https://api.crisp.chat/v1/website/${data.websiteId}/conversation/${data.sessionId}/message`,
      {
        method: "POST",
        headers: crispHeaders(credsResult.creds),
        body: JSON.stringify({
          type: "text",
          from: "operator",
          origin: "chat",
          content: data.content,
        }),
      },
      "interactive",
    );
    console.info(
      JSON.stringify({
        component: "crisp-manual-send",
        path: "visitor",
        websiteId: data.websiteId,
        status: response.status,
        accepted: response.ok,
        externalRequestMs: Math.round(performance.now() - sendStarted),
      }),
    );
    if (!response.ok) {
      return { ok: false as const, error: `Crisp API error: ${await crispErrorReason(response)}` };
    }

    const payload = (await response.json().catch(() => ({}))) as {
      data?: { fingerprint?: string | number; timestamp?: string | number };
      fingerprint?: string | number;
      timestamp?: string | number;
    };
    const message = payload.data ?? payload;
    const crispMessageId = message.fingerprint == null ? null : String(message.fingerprint);
    const sentAt = message.timestamp
      ? new Date(message.timestamp).toISOString()
      : new Date().toISOString();
    const { recordCrispOutgoing } = await import("./crisp.server");
    const conversationId = await recordCrispOutgoing(
      supabaseAdmin as never,
      data.websiteId,
      data.sessionId,
      data.content,
      payload,
    );

    return {
      ok: true as const,
      conversationId,
      crisp_message_id: crispMessageId,
      sent_at: sentAt,
    };
  });

export const sendCrispMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { conversationId: string; content: string }) => {
    const conversationId = String(input?.conversationId ?? "").trim();
    const content = String(input?.content ?? "").trim();
    if (!conversationId || !content)
      throw new Error("conversationId and non-empty content are required");
    return { conversationId, content };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCrispAccess(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getWorkspaceCreds, crispHeaders, crispErrorReason } = await import("./crisp.server");

    const { data: conv } = await supabaseAdmin
      .from("crisp_conversations")
      .select("id, crisp_website_id, crisp_session_id")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (!conv) return { ok: false as const, error: "Conversation not found" };

    const { data: ws } = await supabaseAdmin
      .from("crisp_workspaces")
      .select("credential_secret_id, enabled")
      .eq("crisp_website_id", conv.crisp_website_id)
      .maybeSingle();
    if (!ws?.enabled || !ws.credential_secret_id) {
      return { ok: false as const, error: "Workspace is missing, disabled or not configured." };
    }

    const credsRes = await getWorkspaceCreds(supabaseAdmin as never, ws.credential_secret_id);
    if (!credsRes.ok) return { ok: false as const, error: credsRes.error };

    const sendStarted = performance.now();
    const res = await crispFetch(
      supabaseAdmin as never,
      `https://api.crisp.chat/v1/website/${conv.crisp_website_id}/conversation/${conv.crisp_session_id}/message`,
      {
        method: "POST",
        headers: crispHeaders(credsRes.creds),
        body: JSON.stringify({
          type: "text",
          from: "operator",
          origin: "chat",
          content: data.content,
        }),
      },
      "interactive",
    );

    console.info(
      JSON.stringify({
        component: "crisp-manual-send",
        path: "conversation",
        websiteId: conv.crisp_website_id,
        status: res.status,
        accepted: res.ok,
        externalRequestMs: Math.round(performance.now() - sendStarted),
      }),
    );
    if (!res.ok) {
      return { ok: false as const, error: `Crisp API error: ${await crispErrorReason(res)}` };
    }

    const payload = (await res.json().catch(() => ({}))) as {
      data?: { fingerprint?: string | number; timestamp?: string | number };
    } & Record<string, unknown>;
    const msg =
      (payload?.data as
        | { fingerprint?: string | number; timestamp?: string | number }
        | undefined) ?? (payload as { fingerprint?: string | number; timestamp?: string | number });
    const crispMessageId = msg?.fingerprint == null ? null : String(msg.fingerprint);
    const sentAt = msg?.timestamp
      ? new Date(msg.timestamp).toISOString()
      : new Date().toISOString();

    const { recordCrispOutgoing } = await import("./crisp.server");
    await recordCrispOutgoing(
      supabaseAdmin as never,
      conv.crisp_website_id,
      conv.crisp_session_id,
      data.content,
      payload,
    );

    return { ok: true as const, crisp_message_id: crispMessageId, sent_at: sentAt };
  });

export const markCrispConversationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { conversationId: string }) => {
    const conversationId = String(input?.conversationId ?? "").trim();
    if (!conversationId) throw new Error("conversationId is required");
    return { conversationId };
  })
  .handler(async ({ data, context }) => {
    const observedAt = new Date().toISOString();
    const { supabase, userId } = context;
    await assertCrispAccess(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getWorkspaceCreds, crispHeaders, crispErrorReason } = await import("./crisp.server");

    const { data: conv } = await supabaseAdmin
      .from("crisp_conversations")
      .select("id, crisp_website_id, crisp_session_id")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (!conv) return { ok: false as const, error: "Conversation not found" };

    const { data: ws } = await supabaseAdmin
      .from("crisp_workspaces")
      .select("credential_secret_id, enabled")
      .eq("crisp_website_id", conv.crisp_website_id)
      .maybeSingle();
    if (!ws?.enabled || !ws.credential_secret_id) {
      return { ok: false as const, error: "Workspace is missing, disabled or not configured." };
    }

    const credsRes = await getWorkspaceCreds(supabaseAdmin as never, ws.credential_secret_id);
    if (!credsRes.ok) return { ok: false as const, error: credsRes.error };

    const res = await crispFetch(
      supabaseAdmin as never,
      `https://api.crisp.chat/v1/website/${conv.crisp_website_id}/conversation/${conv.crisp_session_id}/read`,
      {
        method: "PATCH",
        headers: crispHeaders(credsRes.creds),
        body: JSON.stringify({ from: "user", origin: "chat" }),
      },
    ).catch(() => null);

    // A Crisp-side failure should not block clearing the local unread state.
    const crispError = res?.ok
      ? null
      : res
        ? await crispErrorReason(res)
        : "Crisp request unavailable";

    const { markCrispReadLocal } = await import("./crisp.server");
    await markCrispReadLocal(supabaseAdmin as never, conv.id, observedAt);

    if (crispError) console.error("Crisp mark-read failed:", crispError);
    return { ok: true as const };
  });

/**
 * Rejects non-admin callers. See {@link assertCrispAccess} for why the client
 * parameter is typed `unknown` rather than structurally.
 */
async function assertAdmin(client: unknown, userId: string) {
  const { data: roleRows, error: roleErr } = await fetchCallerRoles(client, userId);
  if (roleErr) throw new Error("Could not verify user roles");
  const roles = (roleRows ?? []).map((r: { role: string }) => String(r.role));
  if (!roles.includes("admin")) {
    throw new Error("Forbidden: Workspace management is restricted to JellyBean admin users only.");
  }
}

function newWebhookSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function webhookUrlFor(secret: string) {
  const url = process.env["SUPABASE_URL"]?.trim();
  if (!url) throw new Error("SUPABASE_URL is not configured");
  const ref = url.replace("https://", "").split(".")[0];
  return `https://${ref}.supabase.co/functions/v1/crisp-webhook?key=${secret}`;
}

/** Validate a Crisp Website Token against the website it belongs to. */
async function verifyCrispCredentials(websiteId: string, tokenId: string, tokenKey: string) {
  const auth = btoa(`${tokenId}:${tokenKey}`);

  const res = await fetch(`https://api.crisp.chat/v1/website/${websiteId}`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      "X-Crisp-Tier": "website",
      "Content-Type": "application/json",
    },
  });

  const json = (await res.json().catch(() => ({}))) as {
    reason?: string;
    message?: string;
    data?: { message?: string };
  } & Record<string, unknown>;

  if (!res.ok) {
    const reason = json?.reason || json?.data?.message || json?.message || `HTTP ${res.status}`;
    const details =
      json?.data?.message && json?.data?.message !== reason ? ` — ${json.data.message}` : "";

    return {
      ok: false as const,
      error:
        res.status === 401 || reason === "invalid_session"
          ? `Crisp rejected this Website Token (${reason}${details}). Verify the Website ID, Token Identifier and Token Key all belong to the same workspace and that the token is still valid.`
          : `Crisp API error (${res.status}): ${reason}${details}`,
    };
  }

  return { ok: true as const, info: (json?.data as Record<string, unknown>) ?? {} };
}

export const addCrispWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { websiteId: string; tokenId: string; tokenKey: string }) => {
    const websiteId = String(input?.websiteId ?? "").trim();
    const tokenId = String(input?.tokenId ?? "").trim();
    const tokenKey = String(input?.tokenKey ?? "").trim();
    if (!websiteId || !tokenId || !tokenKey)
      throw new Error("Website ID, API Identifier, and API Key are required");
    return { websiteId, tokenId, tokenKey };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const verified = await verifyCrispCredentials(data.websiteId, data.tokenId, data.tokenKey);
    if (!verified.ok) return { ok: false as const, error: verified.error };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existingWs, error: existingWsErr } = await supabaseAdmin
      .from("crisp_workspaces")
      .select("id, credential_secret_id")
      .eq("crisp_website_id", data.websiteId)
      .maybeSingle();

    if (existingWsErr) {
      return {
        ok: false as const,
        error: `Failed to read workspace record: ${existingWsErr.message}`,
      };
    }

    let secretId = existingWs?.credential_secret_id ?? null;
    let webhookSecret = newWebhookSecret();

    if (secretId) {
      const { data: current, error: currentErr } = await supabaseAdmin.rpc(
        "crisp_get_workspace_secret",
        {
          p_secret_id: secretId,
        },
      );

      if (currentErr || !current) {
        return {
          ok: false as const,
          error: `Failed to read stored Vault credentials: ${currentErr?.message ?? "secret not found"}`,
        };
      }

      webhookSecret =
        ((current as Record<string, unknown>)?.webhook_secret as string) || webhookSecret;

      const { data: updated, error: updErr } = await supabaseAdmin.rpc(
        "crisp_update_workspace_secret",
        {
          p_secret_id: secretId,
          p_token_id: data.tokenId,
          p_token_key: data.tokenKey,
          p_webhook_secret: webhookSecret,
        },
      );

      if (updErr || updated !== true) {
        return {
          ok: false as const,
          error: `Failed to update stored credentials: ${updErr?.message ?? "Vault update returned false"}`,
        };
      }
    } else {
      const { data: newSecretId, error: vaultErr } = await supabaseAdmin.rpc(
        "crisp_create_workspace_secret",
        {
          p_website_id: data.websiteId,
          p_token_id: data.tokenId,
          p_token_key: data.tokenKey,
          p_webhook_secret: webhookSecret,
        },
      );
      if (vaultErr || !newSecretId) {
        return {
          ok: false as const,
          error: `Failed to store credentials: ${vaultErr?.message ?? "unknown error"}`,
        };
      }
      secretId = newSecretId as unknown as string;
    }

    const info = (verified.info as { name?: string; domain?: string; logo?: string }) ?? {};
    const workspaceName = info.name ?? null;

    const { error: wsErr } = await supabaseAdmin.from("crisp_workspaces").upsert(
      {
        ...(existingWs?.id ? { id: existingWs.id } : {}),
        crisp_website_id: data.websiteId,
        workspace_name: workspaceName,
        enabled: true,
        credential_secret_id: secretId,
        installed_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: { domain: info.domain ?? null, logo: info.logo ?? null, tier: "website" },
      },
      { onConflict: "crisp_website_id" },
    );

    if (wsErr) return { ok: false as const, error: `Failed to save workspace: ${wsErr.message}` };

    return {
      ok: true as const,
      workspace_name: workspaceName ?? `Workspace • ${data.websiteId.slice(0, 5)}`,
      webhook_url: webhookUrlFor(webhookSecret),
    };
  });

export const toggleCrispWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { websiteId: string; enabled: boolean }) => {
    const websiteId = String(input?.websiteId ?? "").trim();
    if (!websiteId) throw new Error("websiteId is required");
    return { websiteId, enabled: Boolean(input.enabled) };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("crisp_workspaces")
      .update({ enabled: data.enabled, updated_at: new Date().toISOString() })
      .eq("crisp_website_id", data.websiteId);

    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, enabled: data.enabled };
  });

export const getCrispWorkspaceWebhookUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { websiteId: string }) => {
    const websiteId = String(input?.websiteId ?? "").trim();
    if (!websiteId) throw new Error("websiteId is required");
    return { websiteId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: ws, error: fetchErr } = await supabaseAdmin
      .from("crisp_workspaces")
      .select("credential_secret_id")
      .eq("crisp_website_id", data.websiteId)
      .maybeSingle();

    if (fetchErr || !ws?.credential_secret_id) {
      return { ok: false as const, error: "Workspace credentials not found in Vault." };
    }

    const { data: current, error: currentErr } = await supabaseAdmin.rpc(
      "crisp_get_workspace_secret",
      {
        p_secret_id: ws.credential_secret_id,
      },
    );

    const secret =
      ((current as Record<string, unknown>)?.webhook_secret as string) ||
      ((current as Record<string, unknown>)?.webhookSecret as string);

    if (currentErr || !secret) {
      return {
        ok: false as const,
        error: `Stored Webhook Secret is unavailable: ${currentErr?.message ?? "missing secret"}`,
      };
    }

    return { ok: true as const, webhook_url: webhookUrlFor(secret) };
  });

export const regenerateCrispWebhookSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { websiteId: string }) => {
    const websiteId = String(input?.websiteId ?? "").trim();
    if (!websiteId) throw new Error("websiteId is required");
    return { websiteId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: ws, error: fetchErr } = await supabaseAdmin
      .from("crisp_workspaces")
      .select("credential_secret_id")
      .eq("crisp_website_id", data.websiteId)
      .maybeSingle();

    if (fetchErr || !ws?.credential_secret_id) {
      return {
        ok: false as const,
        error: "Workspace credentials not found. Re-connect the workspace first.",
      };
    }

    const { data: current, error: currentErr } = await supabaseAdmin.rpc(
      "crisp_get_workspace_secret",
      {
        p_secret_id: ws.credential_secret_id,
      },
    );

    const currentTokenId = ((current as Record<string, unknown>)?.token_id as string) ?? "";
    const currentTokenKey = ((current as Record<string, unknown>)?.token_key as string) ?? "";

    if (currentErr || !currentTokenId || !currentTokenKey) {
      return {
        ok: false as const,
        error: `Stored workspace credentials are missing: ${currentErr?.message ?? "re-connect the workspace"}`,
      };
    }

    const secret = newWebhookSecret();
    const { data: updated, error: updErr } = await supabaseAdmin.rpc(
      "crisp_update_workspace_secret",
      {
        p_secret_id: ws.credential_secret_id,
        p_token_id: currentTokenId,
        p_token_key: currentTokenKey,
        p_webhook_secret: secret,
      },
    );

    if (updErr || updated !== true) {
      return { ok: false as const, error: updErr?.message ?? "Vault update returned false" };
    }

    return { ok: true as const, webhook_url: webhookUrlFor(secret) };
  });

export const deleteCrispWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { websiteId: string }) => {
    const websiteId = String(input?.websiteId ?? "").trim();
    if (!websiteId) throw new Error("websiteId is required");
    return { websiteId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Fetch workspace
    const { data: ws, error: fetchErr } = await supabaseAdmin
      .from("crisp_workspaces")
      .select("id, credential_secret_id")
      .eq("crisp_website_id", data.websiteId)
      .maybeSingle();

    if (fetchErr) {
      return { ok: false as const, error: `Failed to find workspace: ${fetchErr.message}` };
    }

    if (ws?.credential_secret_id) {
      // Remove Vault secret if present & verify result (Abort deletion if Vault secret cleanup fails)
      const { data: deletedSecret, error: secretDelErr } = await supabaseAdmin.rpc(
        "crisp_delete_workspace_secret",
        {
          p_secret_id: ws.credential_secret_id,
        },
      );

      if (secretDelErr || deletedSecret !== true) {
        return {
          ok: false as const,
          error: `Failed to clean up workspace Vault secret: ${secretDelErr?.message ?? "Vault secret deletion returned false"}. Workspace deletion aborted.`,
        };
      }
    }

    // Delete workspace registration row (Preserves historical crisp_conversations and crisp_messages)
    const { error: delErr } = await supabaseAdmin
      .from("crisp_workspaces")
      .delete()
      .eq("crisp_website_id", data.websiteId);

    if (delErr) {
      return { ok: false as const, error: `Failed to delete workspace record: ${delErr.message}` };
    }

    return { ok: true as const };
  });

// Configure the per-workspace auto-greeting that the Crisp webhook sends to a
// new live visitor. Admin only.
export const updateCrispWorkspaceAutoGreet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { websiteId: string; enabled: boolean; message: string; delaySeconds?: number }) => {
      const websiteId = String(input?.websiteId ?? "").trim();
      if (!websiteId) throw new Error("websiteId is required");
      const enabled = Boolean(input?.enabled);
      const message = String(input?.message ?? "").trim();
      if (enabled && !message) {
        throw new Error("An auto-greeting message is required to enable auto-greeting.");
      }
      if (message.length > 2000) {
        throw new Error("Auto-greeting message must be 2000 characters or fewer.");
      }
      let delaySeconds = Math.round(Number(input?.delaySeconds ?? 0));
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) delaySeconds = 0;
      if (delaySeconds > 3600) delaySeconds = 3600;
      return { websiteId, enabled, message, delaySeconds };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("crisp_workspaces")
      .update({
        auto_greet_enabled: data.enabled,
        auto_greet_message: data.message || null,
        auto_greet_delay_seconds: data.delaySeconds,
        updated_at: new Date().toISOString(),
      })
      .eq("crisp_website_id", data.websiteId);

    if (error) {
      return { ok: false as const, error: `Failed to save auto-greeting: ${error.message}` };
    }

    return {
      ok: true as const,
      enabled: data.enabled,
      message: data.message,
      delaySeconds: data.delaySeconds,
    };
  });

export const getCrispConversationNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { conversationId: string }) => {
    const conversationId = String(input?.conversationId ?? "").trim();
    if (!conversationId) throw new Error("conversationId is required");
    return { conversationId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: roleRows, error: roleErr } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    if (roleErr) throw new Error("Could not verify user roles");
    const callerRoles = (roleRows ?? []).map((r) => String(r.role));
    if (!callerRoles.some((r) => ["admin", "cs_admin", "cs"].includes(r))) {
      throw new Error("Forbidden: Crisp notes are restricted to admin, cs_admin and cs roles.");
    }

    const isCallerAdmin = callerRoles.includes("admin");
    const isCallerCsAdmin = callerRoles.includes("cs_admin");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: notes, error: notesErr } = await supabaseAdmin
      .from("crisp_conversation_notes")
      .select("*")
      .eq("conversation_id", data.conversationId)
      .order("created_at", { ascending: true });

    if (notesErr) {
      return { ok: false as const, error: notesErr.message, notes: [] };
    }

    if (!notes || notes.length === 0) {
      return { ok: true as const, notes: [] };
    }

    const userIds = Array.from(new Set(notes.map((n) => n.created_by)));

    // Fetch user profiles by user_id
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("user_id, full_name, username, email")
      .in("user_id", userIds);

    const profilesMap = new Map<string, string>();
    (profiles || []).forEach((p) => {
      const name =
        p.full_name?.trim() || p.username?.trim() || p.email?.split("@")[0] || "Team Member";
      profilesMap.set(p.user_id, name);
    });

    // Fetch roles for authors to evaluate deletion permissions
    const { data: authorRoles } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", userIds);

    const rolesMap = new Map<string, string[]>();
    (authorRoles || []).forEach((r) => {
      const existing = rolesMap.get(r.user_id) || [];
      existing.push(String(r.role));
      rolesMap.set(r.user_id, existing);
    });

    const enrichedNotes = notes.map((n) => {
      const isSelf = n.created_by === userId;
      const authorRolesList = rolesMap.get(n.created_by) || [];
      const authorIsAdmin = authorRolesList.includes("admin");
      const authorName = profilesMap.get(n.created_by) || "Team Member";

      let canDelete = false;
      if (isCallerAdmin) {
        canDelete = true;
      } else if (isCallerCsAdmin) {
        canDelete = isSelf || !authorIsAdmin;
      } else {
        canDelete = isSelf;
      }

      return {
        id: n.id,
        conversation_id: n.conversation_id,
        created_by: n.created_by,
        note: n.note,
        is_edited: n.is_edited,
        created_at: n.created_at,
        updated_at: n.updated_at,
        author_name: authorName,
        can_delete: canDelete,
      };
    });

    return { ok: true as const, notes: enrichedNotes };
  });

export const addCrispConversationNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { conversationId: string; note: string }) => {
    const conversationId = String(input?.conversationId ?? "").trim();
    const note = String(input?.note ?? "").trim();
    if (!conversationId || !note) throw new Error("conversationId and non-empty note are required");
    return { conversationId, note };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: roleRows, error: roleErr } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    if (roleErr) throw new Error("Could not verify user roles");
    const roles = (roleRows ?? []).map((r) => String(r.role));
    if (!roles.some((r) => ["admin", "cs_admin", "cs"].includes(r))) {
      throw new Error("Forbidden: Crisp notes are restricted to admin, cs_admin and cs roles.");
    }

    const { data: created, error } = await supabase
      .from("crisp_conversation_notes")
      .insert({
        conversation_id: data.conversationId,
        created_by: userId,
        note: data.note,
      })
      .select()
      .single();

    if (error) {
      return { ok: false as const, error: error.message };
    }

    return { ok: true as const, note: created };
  });

export const deleteCrispConversationNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { noteId: string }) => {
    const noteId = String(input?.noteId ?? "").trim();
    if (!noteId) throw new Error("noteId is required");
    return { noteId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: roleRows, error: roleErr } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    if (roleErr) throw new Error("Could not verify user roles");
    const callerRoles = (roleRows ?? []).map((r) => String(r.role));
    if (!callerRoles.some((r) => ["admin", "cs_admin", "cs"].includes(r))) {
      throw new Error("Forbidden: Crisp notes are restricted to admin, cs_admin and cs roles.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Fetch the target note to check creator
    const { data: note, error: noteErr } = await supabaseAdmin
      .from("crisp_conversation_notes")
      .select("id, created_by")
      .eq("id", data.noteId)
      .maybeSingle();

    if (noteErr || !note) {
      return { ok: false as const, error: "Note not found." };
    }

    const isSelf = note.created_by === userId;
    const isCallerAdmin = callerRoles.includes("admin");
    const isCallerCsAdmin = callerRoles.includes("cs_admin");

    if (isCallerAdmin) {
      // Admin can delete all notes
    } else if (isCallerCsAdmin) {
      // CS Admin can delete own notes or CS notes, but not Admin notes
      if (!isSelf) {
        const { data: authorRoleRows } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", note.created_by);
        const authorRoles = (authorRoleRows ?? []).map((r) => String(r.role));
        if (authorRoles.includes("admin")) {
          return {
            ok: false as const,
            error: "Forbidden: CS Admin cannot delete notes written by an Admin.",
          };
        }
      }
    } else {
      // CS can only delete their own notes
      if (!isSelf) {
        return { ok: false as const, error: "Forbidden: You can only delete your own notes." };
      }
    }

    const { error } = await supabaseAdmin
      .from("crisp_conversation_notes")
      .delete()
      .eq("id", data.noteId);

    if (error) {
      return { ok: false as const, error: error.message };
    }

    return { ok: true as const };
  });
