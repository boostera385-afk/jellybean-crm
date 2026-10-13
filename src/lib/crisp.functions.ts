import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";

const CRISP_ROLES = ["admin", "cs_admin", "cs"];
const CRISP_VISITOR_PAGE_LIMIT = 10;
const CRISP_VISITOR_TIME_ZONE = "Asia/Karachi";

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
  errors?: string[];
  error?: string;
};

type CrispApiVisitor = {
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

type CrispWorkspaceRow = {
  crisp_website_id: string;
  workspace_name: string;
  credential_secret_id: string;
  live_visitor_count: number;
  active_visitor_count: number;
  visitors_limited: boolean;
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

/**
 * Send the per-workspace auto-greeting to eligible live visitors.
 *
 * Runs server-side from the visitor-overview sync (the authoritative source of
 * who is live). For each live visitor that has not been greeted, has no ongoing
 * conversation, and whose optional delay has elapsed, it posts the greeting to
 * Crisp, records the message, and marks the visitor greeted. The per-visitor
 * `auto_greeted_at` claim (NULL -> now) makes it safe against concurrent syncs.
 */
async function autoGreetLiveVisitors({
  supabaseAdmin,
  websiteId,
  headers,
  message,
  delaySeconds,
  liveVisitors,
  nowIso,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabaseAdmin: any;
  websiteId: string;
  headers: Record<string, string>;
  message: string;
  delaySeconds: number;
  liveVisitors: CrispVisitor[];
  nowIso: string;
}): Promise<void> {
  if (liveVisitors.length === 0) return;
  const sessionIds = liveVisitors.map((v) => v.crisp_session_id);

  type GreetRow = {
    crisp_session_id: string;
    auto_greeted_at: string | null;
    auto_greet_due_at: string | null;
  };
  const { data: visitorRows } = await supabaseAdmin
    .from("crisp_visitors")
    .select("crisp_session_id, auto_greeted_at, auto_greet_due_at")
    .eq("crisp_website_id", websiteId)
    .in("crisp_session_id", sessionIds);
  const greetState = new Map<string, GreetRow>(
    ((visitorRows ?? []) as GreetRow[]).map((r) => [r.crisp_session_id, r]),
  );

  type ConvRow = { crisp_session_id: string; last_message: string | null };
  const { data: convRows } = await supabaseAdmin
    .from("crisp_conversations")
    .select("crisp_session_id, last_message")
    .eq("crisp_website_id", websiteId)
    .in("crisp_session_id", sessionIds);
  const convBySession = new Map<string, ConvRow>(
    ((convRows ?? []) as ConvRow[]).map((c) => [c.crisp_session_id, c]),
  );

  const nowMs = Date.now();

  for (const visitor of liveVisitors) {
    const sessionId = visitor.crisp_session_id;
    const state = greetState.get(sessionId);
    if (state?.auto_greeted_at) continue; // already greeted
    const conv = convBySession.get(sessionId);
    if (conv && conv.last_message) continue; // already in a conversation

    const dueAtMs = state?.auto_greet_due_at ? new Date(state.auto_greet_due_at).getTime() : null;
    if (dueAtMs == null) {
      if (delaySeconds > 0) {
        // First time we see them live with a delay set — schedule, send later.
        await supabaseAdmin
          .from("crisp_visitors")
          .update({ auto_greet_due_at: new Date(nowMs + delaySeconds * 1000).toISOString() })
          .eq("crisp_website_id", websiteId)
          .eq("crisp_session_id", sessionId)
          .is("auto_greet_due_at", null);
        continue;
      }
      // delaySeconds === 0 → send now.
    } else if (nowMs < dueAtMs) {
      continue; // scheduled, not due yet
    }

    // Atomically claim so overlapping syncs can't double-send.
    const { data: claimed } = await supabaseAdmin
      .from("crisp_visitors")
      .update({ auto_greeted_at: new Date().toISOString() })
      .eq("crisp_website_id", websiteId)
      .eq("crisp_session_id", sessionId)
      .is("auto_greeted_at", null)
      .select("crisp_session_id")
      .maybeSingle();
    if (!claimed) continue;

    const content = message
      .replace(/\{\{\s*name\s*\}\}/gi, visitor.nickname || "there")
      .replace(/\{\{\s*city\s*\}\}/gi, visitor.city || "");

    try {
      const res = await fetch(
        `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/message`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ type: "text", from: "operator", origin: "chat", content }),
        },
      );
      const resData = (await res.json().catch(() => ({}))) as {
        data?: { fingerprint?: number; timestamp?: number };
        fingerprint?: number;
        timestamp?: number;
      };

      if (!res.ok) {
        // Release the claim so a later sync can retry.
        await supabaseAdmin
          .from("crisp_visitors")
          .update({ auto_greeted_at: null })
          .eq("crisp_website_id", websiteId)
          .eq("crisp_session_id", sessionId);
        continue;
      }

      const msg = resData.data || resData;
      const crispMsgId = String(msg.fingerprint || `autogreet_${Date.now()}`);
      const sentAt = msg.timestamp
        ? new Date(msg.timestamp).toISOString()
        : new Date().toISOString();

      // Upsert the conversation so the greeting shows up in the inbox even if
      // the webhook does not relay our own outgoing message.
      const { data: convRow } = await supabaseAdmin
        .from("crisp_conversations")
        .upsert(
          {
            crisp_website_id: websiteId,
            crisp_session_id: sessionId,
            customer_name: visitor.nickname || null,
            customer_email: visitor.email || null,
            customer_avatar: visitor.avatar || null,
            last_message: content,
            last_message_at: sentAt,
            unread_count: 0,
            updated_at: nowIso,
          },
          { onConflict: "crisp_website_id,crisp_session_id" },
        )
        .select("id")
        .maybeSingle();

      if (convRow?.id) {
        await supabaseAdmin.from("crisp_messages").insert({
          conversation_id: convRow.id,
          crisp_website_id: websiteId,
          crisp_session_id: sessionId,
          crisp_message_id: crispMsgId,
          sender_type: "operator",
          direction: "outgoing",
          content,
          message_type: "text",
          sent_at: sentAt,
          raw_payload: resData,
        });
      }
    } catch {
      // Network/Crisp error — release the claim so it can retry next sync.
      await supabaseAdmin
        .from("crisp_visitors")
        .update({ auto_greeted_at: null })
        .eq("crisp_website_id", websiteId)
        .eq("crisp_session_id", sessionId);
    }
  }
}

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
    const { getWorkspaceCreds, crispHeaders, crispErrorReason } = await import("./crisp.server");
    const now = new Date();
    const nowIso = now.toISOString();
    const visitDate = pakistanDayKey(now);

    let workspaceQuery = supabaseAdmin
      .from("crisp_workspaces")
      .select(
        "crisp_website_id, workspace_name, credential_secret_id, live_visitor_count, active_visitor_count, visitors_limited, auto_greet_enabled, auto_greet_message, auto_greet_delay_seconds",
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
      (workspaces ?? []).map((workspace: CrispWorkspaceRow) => [workspace.crisp_website_id, workspace.workspace_name]),
    );
    const errors: string[] = [];
    let reportedLiveCount = 0;
    let reportedActiveCount = 0;
    let limited = false;

    const staleBefore = new Date(now.getTime() - 60_000).toISOString();
    await Promise.all(
      (workspaces ?? []).map(async (workspace: CrispWorkspaceRow): Promise<CrispVisitor[]> => {
        try {
          const { data: claimed } = await supabaseAdmin.rpc("claim_crisp_visitor_sync", {
            p_website_id: workspace.crisp_website_id,
            p_stale_before: staleBefore,
          });
          if (!claimed) {
            reportedLiveCount += workspace.live_visitor_count;
            reportedActiveCount += workspace.active_visitor_count;
            limited = limited || workspace.visitors_limited;
            return [];
          }

          if (!workspace.credential_secret_id) {
            errors.push(
              `${workspace.workspace_name || workspace.crisp_website_id}: missing credentials`,
            );
            return [];
          }

          const credsResult = await getWorkspaceCreds(
            supabaseAdmin as never,
            workspace.credential_secret_id,
          );
          if (!credsResult.ok) {
            errors.push(
              `${workspace.workspace_name || workspace.crisp_website_id}: ${credsResult.error}`,
            );
            return [];
          }

          const headers = crispHeaders(credsResult.creds);
          const countResponse = await fetch(
            `https://api.crisp.chat/v1/website/${workspace.crisp_website_id}/visitors/count`,
            { headers },
          ).catch(() => null);
          let countedLive: number | null = null;
          let countedActive: number | null = null;
          let workspaceLimited = false;
          if (countResponse?.ok) {
            const countPayload = (await countResponse.json().catch(() => ({}))) as {
              data?: { count?: number; active?: number; limited?: boolean };
            };
            countedLive = Number(countPayload.data?.count ?? 0);
            countedActive = Number(countPayload.data?.active ?? 0);
            workspaceLimited = Boolean(countPayload.data?.limited);
          }

          const visitorRows: CrispApiVisitor[] = [];
          let listSucceeded = true;

          for (
            let page = 1;
            page <= CRISP_VISITOR_PAGE_LIMIT && (countedLive === null || countedLive > 0);
            page++
          ) {
            const response = await fetch(
              `https://api.crisp.chat/v1/website/${workspace.crisp_website_id}/visitors/list/${page}`,
              { headers },
            );
            if (!response.ok) {
              errors.push(
                `${workspace.workspace_name || workspace.crisp_website_id}: ${await crispErrorReason(response)}`,
              );
              listSucceeded = false;
              break;
            }
            const payload = (await response.json().catch(() => ({}))) as {
              data?: CrispApiVisitor[];
            };
            const pageRows = Array.isArray(payload.data) ? payload.data : [];
            visitorRows.push(...pageRows);
            if (
              pageRows.length === 0 ||
              (countedLive !== null && visitorRows.length >= countedLive)
            ) {
              break;
            }
          }

          const workspaceLiveCount = countedLive ?? visitorRows.length;
          const workspaceActiveCount =
            countedActive ?? visitorRows.filter((visitor) => visitor.active).length;
          reportedLiveCount += workspaceLiveCount;
          reportedActiveCount += workspaceActiveCount;
          limited = limited || workspaceLimited;
          await supabaseAdmin
            .from("crisp_workspaces")
            .update({
              live_visitor_count: workspaceLiveCount,
              active_visitor_count: workspaceActiveCount,
              visitors_limited: workspaceLimited,
              visitor_synced_at: nowIso,
              updated_at: nowIso,
            })
            .eq("crisp_website_id", workspace.crisp_website_id);

          const normalized = visitorRows
            .filter((visitor): visitor is CrispApiVisitor & { session_id: string } =>
              Boolean(visitor.session_id),
            )
            .map((visitor): CrispVisitor => ({
              crisp_website_id: workspace.crisp_website_id,
              workspace_name: workspace.workspace_name,
              crisp_session_id: visitor.session_id,
              nickname: visitor.nickname || null,
              email: visitor.email || null,
              avatar: visitor.avatar || null,
              user_agent: visitor.useragent || null,
              initiated: Boolean(visitor.initiated),
              active: Boolean(visitor.active),
              is_online: true,
              last_page_title: visitor.last_page?.page_title || null,
              last_page_url: visitor.last_page?.page_url || null,
              country: visitor.geolocation?.country || null,
              region: visitor.geolocation?.region || null,
              city: visitor.geolocation?.city || null,
              latitude: visitor.geolocation?.coordinates?.latitude ?? null,
              longitude: visitor.geolocation?.coordinates?.longitude ?? null,
              timezone_minutes: visitor.timezone ?? null,
              capabilities: Array.isArray(visitor.capabilities) ? visitor.capabilities : [],
              locales: Array.isArray(visitor.locales) ? visitor.locales : [],
              first_seen_at: nowIso,
              last_seen_at: nowIso,
            }));

          if (listSucceeded) {
            await supabaseAdmin
              .from("crisp_visitors")
              .update({ is_online: false, active: false, updated_at: nowIso })
              .eq("crisp_website_id", workspace.crisp_website_id)
              .eq("is_online", true);
          }

          if (normalized.length > 0) {
            const { error: visitorError } = await supabaseAdmin.from("crisp_visitors").upsert(
              normalized.map(
                ({ workspace_name: _workspaceName, first_seen_at: _firstSeen, ...visitor }) => ({
                  ...visitor,
                  last_online_at: nowIso,
                  updated_at: nowIso,
                }),
              ),
              { onConflict: "crisp_website_id,crisp_session_id" },
            );
            if (visitorError) {
              errors.push(
                `${workspace.workspace_name || workspace.crisp_website_id}: visitor history is unavailable (${visitorError.message})`,
              );
            }

            await supabaseAdmin.from("crisp_visitor_daily_visits").upsert(
              normalized.map((visitor) => ({
                crisp_website_id: visitor.crisp_website_id,
                crisp_session_id: visitor.crisp_session_id,
                visit_date: visitDate,
                last_seen_at: nowIso,
                updated_at: nowIso,
              })),
              { onConflict: "crisp_website_id,crisp_session_id,visit_date" },
            );
          }

          // Auto-greet eligible live visitors. This runs inside the claim-won
          // branch, so it fires at most once per sync window per workspace —
          // and, crucially, from the same path that actually detects who is
          // live (the webhook may never see presence events).
          const autoGreetMessage =
            typeof workspace.auto_greet_message === "string"
              ? workspace.auto_greet_message.trim()
              : "";
          if (workspace.auto_greet_enabled && autoGreetMessage) {
            try {
              await autoGreetLiveVisitors({
                supabaseAdmin,
                websiteId: workspace.crisp_website_id,
                headers,
                message: autoGreetMessage,
                delaySeconds: Math.max(
                  0,
                  Math.min(3600, Number(workspace.auto_greet_delay_seconds) || 0),
                ),
                liveVisitors: normalized,
                nowIso,
              });
            } catch (greetError) {
              errors.push(
                `${workspace.workspace_name || workspace.crisp_website_id}: auto-greet failed (${
                  greetError instanceof Error ? greetError.message : "unknown error"
                })`,
              );
            }
          }

          return normalized;
        } catch (error) {
          reportedLiveCount += workspace.live_visitor_count;
          reportedActiveCount += workspace.active_visitor_count;
          limited = limited || workspace.visitors_limited;
          errors.push(
            `${workspace.workspace_name || workspace.crisp_website_id}: ${error instanceof Error ? error.message : "visitor refresh failed"}`,
          );
          return [];
        }
      }),
    );

    let liveQuery = supabaseAdmin
      .from("crisp_visitors")
      .select("*")
      .eq("is_online", true)
      .order("active", { ascending: false })
      .order("last_seen_at", { ascending: false });
    if (data.websiteId) liveQuery = liveQuery.eq("crisp_website_id", data.websiteId);
    const { data: liveRows, error: liveError } = await liveQuery;
    if (liveError) errors.push(`Live visitor details are unavailable: ${liveError.message}`);

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
    const liveVisitors = (liveRows ?? []).map(mapVisitor);

    let todayQuery = supabaseAdmin
      .from("crisp_visitors")
      .select("*")
      .gte("last_seen_at", pakistanDayStartIso(now))
      .order("last_seen_at", { ascending: false });
    if (data.websiteId) todayQuery = todayQuery.eq("crisp_website_id", data.websiteId);
    const { data: todayRows, error: todayError } = await todayQuery;

    if (todayError) {
      errors.push(`Today's visitor details are unavailable: ${todayError.message}`);
    }

    const todayVisitors: CrispVisitor[] = (todayRows ?? []).map(mapVisitor);

    return {
      ok: errors.length === 0 || liveVisitors.length > 0 || todayVisitors.length > 0,
      liveVisitors,
      todayVisitors,
      liveCount: Math.max(reportedLiveCount, liveVisitors.length),
      activeCount: Math.max(
        reportedActiveCount,
        liveVisitors.filter((visitor: CrispVisitor) => visitor.active).length,
      ),
      todayCount: todayVisitors.length,
      limited,
      fetchedAt: nowIso,
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

    const response = await fetch(
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
    const crispMessageId = String(message.fingerprint ?? Date.now());
    const sentAt = message.timestamp
      ? new Date(message.timestamp).toISOString()
      : new Date().toISOString();
    const [{ data: visitor }, { data: existingConversation }] = await Promise.all([
      (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any

        .from("crisp_visitors")
        .select("nickname, email, avatar")
        .eq("crisp_website_id", data.websiteId)
        .eq("crisp_session_id", data.sessionId)
        .maybeSingle(),
      supabaseAdmin
        .from("crisp_conversations")
        .select("customer_name, customer_email, customer_avatar")
        .eq("crisp_website_id", data.websiteId)
        .eq("crisp_session_id", data.sessionId)
        .maybeSingle(),
    ]);

    const { data: conversation, error: conversationError } = await supabaseAdmin
      .from("crisp_conversations")
      .upsert(
        {
          crisp_website_id: data.websiteId,
          crisp_session_id: data.sessionId,
          customer_name: visitor?.nickname || existingConversation?.customer_name || null,
          customer_email: visitor?.email || existingConversation?.customer_email || null,
          customer_avatar: visitor?.avatar || existingConversation?.customer_avatar || null,
          status: "unresolved",
          last_message: data.content,
          last_message_at: sentAt,
          unread_count: 0,
          last_customer_unread_at: null,
          updated_at: sentAt,
        },
        { onConflict: "crisp_website_id,crisp_session_id" },
      )
      .select("id")
      .single();
    if (conversationError || !conversation) {
      return {
        ok: false as const,
        error: `Message reached Crisp but could not be added to the CRM: ${conversationError?.message || "conversation unavailable"}`,
      };
    }

    await supabaseAdmin.from("crisp_messages").upsert(
      {
        conversation_id: conversation.id,
        crisp_website_id: data.websiteId,
        crisp_session_id: data.sessionId,
        crisp_message_id: crispMessageId,
        sender_type: "operator",
        direction: "outgoing",
        content: data.content,
        message_type: "text",
        sent_at: sentAt,
        raw_payload: payload as Json,
      },
      { onConflict: "crisp_website_id,crisp_message_id", ignoreDuplicates: true },
    );

    return {
      ok: true as const,
      conversationId: conversation.id,
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

    const res = await fetch(
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
    );

    if (!res.ok) {
      return { ok: false as const, error: `Crisp API error: ${await crispErrorReason(res)}` };
    }

    const payload = (await res.json().catch(() => ({}))) as {
      data?: { fingerprint?: string | number; timestamp?: string | number };
    } & Record<string, unknown>;
    const msg =
      (payload?.data as
        { fingerprint?: string | number; timestamp?: string | number } | undefined) ??
      (payload as { fingerprint?: string | number; timestamp?: string | number });
    const crispMessageId = String(msg?.fingerprint ?? Date.now());
    const sentAt = msg?.timestamp
      ? new Date(msg.timestamp).toISOString()
      : new Date().toISOString();

    await supabaseAdmin
      .from("crisp_conversations")
      .update({
        last_message: data.content,
        last_message_at: sentAt,
        unread_count: 0,
        last_customer_unread_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conv.id);

    await supabaseAdmin.from("crisp_messages").insert({
      conversation_id: conv.id,
      crisp_website_id: conv.crisp_website_id,
      crisp_session_id: conv.crisp_session_id,
      crisp_message_id: crispMessageId,
      sender_type: "operator",
      direction: "outgoing",
      content: data.content,
      message_type: "text",
      sent_at: sentAt,
      raw_payload: payload as Json,
    });

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

    const res = await fetch(
      `https://api.crisp.chat/v1/website/${conv.crisp_website_id}/conversation/${conv.crisp_session_id}/read`,
      {
        method: "PATCH",
        headers: crispHeaders(credsRes.creds),
        body: JSON.stringify({ from: "user", origin: "chat" }),
      },
    );

    // A Crisp-side failure should not block clearing the local unread state.
    const crispError = res.ok ? null : await crispErrorReason(res);

    const { error: updErr } = await supabaseAdmin
      .from("crisp_conversations")
      .update({
        unread_count: 0,
        last_customer_unread_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conv.id);
    if (updErr) return { ok: false as const, error: `Database update failed: ${updErr.message}` };

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
