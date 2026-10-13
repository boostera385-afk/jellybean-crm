// Server-side auto-greeting sweeper for Crisp live visitors.
//
// Invoked on a short pg_cron schedule (independent of any operator browser), it
// syncs each auto-greet-enabled workspace's live visitors from the Crisp API and
// sends the configured greeting to eligible ones. It shares the same
// claim_crisp_visitor_sync lock as the in-app visitor overview, so the two never
// double-fetch Crisp, and the per-visitor auto_greeted_at claim prevents
// double-sends.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CRISP_VISITOR_PAGE_LIMIT = 10;
const SYNC_STALE_MS = 4_000;

type CrispApiVisitor = {
  session_id?: string;
  nickname?: string | null;
  email?: string | null;
  avatar?: string | null;
  useragent?: string | null;
  initiated?: boolean;
  active?: boolean;
  last_page?: { page_title?: string | null; page_url?: string | null } | null;
  geolocation?: {
    country?: string | null;
    region?: string | null;
    city?: string | null;
    coordinates?: { latitude?: number | null; longitude?: number | null } | null;
  } | null;
  timezone?: number | null;
  capabilities?: string[];
  locales?: string[];
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function crispHeaders(tokenId: string, tokenKey: string): Record<string, string> {
  return {
    Authorization: `Basic ${btoa(`${tokenId}:${tokenKey}`)}`,
    "X-Crisp-Tier": "website",
    "Content-Type": "application/json",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "Server configuration missing" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Authorize the caller. The pg_cron job sends a service-role key. Accept it
  // either by exact match against this function's injected service-role key, or
  // by validating the bearer is a non-expired service_role JWT for THIS project
  // (covers projects that have more than one valid service-role key, e.g. after
  // a JWT-secret rotation, where the injected key differs from the stored one).
  const auth = req.headers.get("Authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const projectRef = supabaseUrl.match(/^https:\/\/([^.]+)\./)?.[1] || "";

  let authorized = bearer.length > 0 && bearer === serviceKey.trim();
  if (!authorized && bearer) {
    const claims = decodeJwtPayload(bearer);
    const exp = typeof claims?.exp === "number" ? (claims.exp as number) : null;
    const notExpired = exp === null || exp * 1000 > Date.now();
    authorized =
      claims?.role === "service_role" &&
      (claims?.ref === projectRef || projectRef === "") &&
      notExpired;
  }
  if (!authorized) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: workspaces, error: wsErr } = await supabase
    .from("crisp_workspaces")
    .select(
      "crisp_website_id, workspace_name, credential_secret_id, auto_greet_enabled, auto_greet_message, auto_greet_delay_seconds",
    )
    .eq("enabled", true)
    .eq("auto_greet_enabled", true);

  if (wsErr) {
    return new Response(JSON.stringify({ error: wsErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - SYNC_STALE_MS).toISOString();
  let greeted = 0;

  await Promise.all(
    (workspaces ?? []).map(async (ws) => {
      const websiteId = ws.crisp_website_id as string;
      const message =
        typeof ws.auto_greet_message === "string" ? ws.auto_greet_message.trim() : "";
      if (!message || !ws.credential_secret_id) return;

      try {
        // Share the sync lock with the in-app overview so we don't double-hit Crisp.
        const { data: claimed } = await supabase.rpc("claim_crisp_visitor_sync", {
          p_website_id: websiteId,
          p_stale_before: staleBefore,
        });
        if (!claimed) return;

        const { data: secret } = await supabase.rpc("crisp_get_workspace_secret", {
          p_secret_id: ws.credential_secret_id,
        });
        const tokenId = secret?.token_id as string | undefined;
        const tokenKey = secret?.token_key as string | undefined;
        if (!tokenId || !tokenKey) return;
        const headers = crispHeaders(tokenId, tokenKey);

        // Fetch the live visitor list from Crisp.
        const countRes = await fetch(
          `https://api.crisp.chat/v1/website/${websiteId}/visitors/count`,
          { headers },
        ).catch(() => null);
        let countedLive: number | null = null;
        if (countRes?.ok) {
          const cp = (await countRes.json().catch(() => ({}))) as {
            data?: { count?: number };
          };
          countedLive = Number(cp.data?.count ?? 0);
        }

        const rows: CrispApiVisitor[] = [];
        let listOk = true;
        for (
          let page = 1;
          page <= CRISP_VISITOR_PAGE_LIMIT && (countedLive === null || countedLive > 0);
          page++
        ) {
          const res = await fetch(
            `https://api.crisp.chat/v1/website/${websiteId}/visitors/list/${page}`,
            { headers },
          );
          if (!res.ok) {
            listOk = false;
            break;
          }
          const payload = (await res.json().catch(() => ({}))) as { data?: CrispApiVisitor[] };
          const pageRows = Array.isArray(payload.data) ? payload.data : [];
          rows.push(...pageRows);
          if (pageRows.length === 0 || (countedLive !== null && rows.length >= countedLive)) break;
        }

        const live = rows.filter((v): v is CrispApiVisitor & { session_id: string } =>
          Boolean(v.session_id),
        );

        // Refresh presence so the UI stays current even with no browser open.
        if (listOk) {
          await supabase
            .from("crisp_visitors")
            .update({ is_online: false, active: false, updated_at: nowIso })
            .eq("crisp_website_id", websiteId)
            .eq("is_online", true);
        }

        if (live.length > 0) {
          await supabase.from("crisp_visitors").upsert(
            live.map((v) => ({
              crisp_website_id: websiteId,
              crisp_session_id: v.session_id,
              nickname: v.nickname || null,
              email: v.email || null,
              avatar: v.avatar || null,
              user_agent: v.useragent || null,
              initiated: Boolean(v.initiated),
              active: Boolean(v.active),
              is_online: true,
              last_page_title: v.last_page?.page_title || null,
              last_page_url: v.last_page?.page_url || null,
              country: v.geolocation?.country || null,
              region: v.geolocation?.region || null,
              city: v.geolocation?.city || null,
              latitude: v.geolocation?.coordinates?.latitude ?? null,
              longitude: v.geolocation?.coordinates?.longitude ?? null,
              timezone_minutes: v.timezone ?? null,
              capabilities: Array.isArray(v.capabilities) ? v.capabilities : [],
              locales: Array.isArray(v.locales) ? v.locales : [],
              last_online_at: nowIso,
              last_seen_at: nowIso,
              updated_at: nowIso,
            })),
            { onConflict: "crisp_website_id,crisp_session_id" },
          );
        }

        greeted += await autoGreet({
          supabase,
          websiteId,
          headers,
          message,
          delaySeconds: Math.max(0, Math.min(3600, Number(ws.auto_greet_delay_seconds) || 0)),
          live,
          nowIso,
        });
      } catch (err) {
        console.error(`Auto-greet sweep failed for ${websiteId}:`, err);
      }
    }),
  );

  return new Response(JSON.stringify({ status: "ok", greeted }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

// deno-lint-ignore no-explicit-any
async function autoGreet(opts: {
  supabase: any;
  websiteId: string;
  headers: Record<string, string>;
  message: string;
  delaySeconds: number;
  live: Array<CrispApiVisitor & { session_id: string }>;
  nowIso: string;
}): Promise<number> {
  const { supabase, websiteId, headers, message, delaySeconds, live, nowIso } = opts;
  if (live.length === 0) return 0;
  const sessionIds = live.map((v) => v.session_id);

  type GreetRow = {
    crisp_session_id: string;
    auto_greeted_at: string | null;
    auto_greet_due_at: string | null;
  };
  const { data: vrows } = await supabase
    .from("crisp_visitors")
    .select("crisp_session_id, auto_greeted_at, auto_greet_due_at")
    .eq("crisp_website_id", websiteId)
    .in("crisp_session_id", sessionIds);
  const greetState = new Map<string, GreetRow>(
    ((vrows ?? []) as GreetRow[]).map((r) => [r.crisp_session_id, r]),
  );

  type ConvRow = { crisp_session_id: string; last_message: string | null };
  const { data: convs } = await supabase
    .from("crisp_conversations")
    .select("crisp_session_id, last_message")
    .eq("crisp_website_id", websiteId)
    .in("crisp_session_id", sessionIds);
  const convBySession = new Map<string, ConvRow>(
    ((convs ?? []) as ConvRow[]).map((c) => [c.crisp_session_id, c]),
  );

  const nowMs = Date.now();
  let sent = 0;

  for (const v of live) {
    const sessionId = v.session_id;
    const state = greetState.get(sessionId);
    if (state?.auto_greeted_at) continue;
    const conv = convBySession.get(sessionId);
    if (conv && conv.last_message) continue;

    const dueAtMs = state?.auto_greet_due_at ? new Date(state.auto_greet_due_at).getTime() : null;
    if (dueAtMs == null) {
      if (delaySeconds > 0) {
        await supabase
          .from("crisp_visitors")
          .update({ auto_greet_due_at: new Date(nowMs + delaySeconds * 1000).toISOString() })
          .eq("crisp_website_id", websiteId)
          .eq("crisp_session_id", sessionId)
          .is("auto_greet_due_at", null);
        continue;
      }
    } else if (nowMs < dueAtMs) {
      continue;
    }

    const { data: claimed } = await supabase
      .from("crisp_visitors")
      .update({ auto_greeted_at: new Date().toISOString() })
      .eq("crisp_website_id", websiteId)
      .eq("crisp_session_id", sessionId)
      .is("auto_greeted_at", null)
      .select("crisp_session_id")
      .maybeSingle();
    if (!claimed) continue;

    const content = message
      .replace(/\{\{\s*name\s*\}\}/gi, v.nickname || "there")
      .replace(/\{\{\s*city\s*\}\}/gi, v.geolocation?.city || "");

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
        await supabase
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

      const { data: convRow } = await supabase
        .from("crisp_conversations")
        .upsert(
          {
            crisp_website_id: websiteId,
            crisp_session_id: sessionId,
            customer_name: v.nickname || null,
            customer_email: v.email || null,
            customer_avatar: v.avatar || null,
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
        await supabase.from("crisp_messages").insert({
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
      sent++;
    } catch {
      await supabase
        .from("crisp_visitors")
        .update({ auto_greeted_at: null })
        .eq("crisp_website_id", websiteId)
        .eq("crisp_session_id", sessionId);
    }
  }

  return sent;
}
