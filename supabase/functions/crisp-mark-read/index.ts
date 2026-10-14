import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { crispFetch } from "../_shared/crisp-api.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "cs"]);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const observedAt = new Date().toISOString();
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: "Server configuration missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── CALLER AUTHENTICATION ──────────────────────────────────────────────────
    // Independently verify the caller's JWT and role — do not rely on the
    // server wrapper having already checked this.
    const authHeader = req.headers.get("authorization") || "";
    const callerToken = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!callerToken) {
      return new Response(JSON.stringify({ error: "Unauthorized: Missing authorization token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use a caller-scoped client (anon key + user JWT) to verify identity
    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${callerToken}` } },
    });

    const {
      data: { user },
      error: userErr,
    } = await callerClient.auth.getUser();

    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized: Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Look up the caller's primary role from the profiles table
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: profile, error: profileErr } = await serviceClient
      .from("profiles")
      .select("primary_role")
      .eq("id", user.id)
      .maybeSingle();

    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: "Unauthorized: Could not resolve user role" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!ALLOWED_ROLES.has(profile.primary_role)) {
      return new Response(JSON.stringify({ error: "Forbidden: Insufficient role" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // ──────────────────────────────────────────────────────────────────────────

    const body = await req.json().catch(() => ({}));
    const conversationId = String(body.conversationId || "").trim();

    if (!conversationId) {
      return new Response(JSON.stringify({ error: "conversationId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Fetch conversation details
    const { data: conv, error: convErr } = await serviceClient
      .from("crisp_conversations")
      .select("id, crisp_website_id, crisp_session_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr || !conv) {
      return new Response(JSON.stringify({ error: "Conversation not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const websiteId = conv.crisp_website_id;
    const sessionId = conv.crisp_session_id;

    // 2. Fetch workspace secret reference from Vault
    const { data: ws, error: wsErr } = await serviceClient
      .from("crisp_workspaces")
      .select("credential_secret_id, enabled")
      .eq("crisp_website_id", websiteId)
      .maybeSingle();

    if (wsErr || !ws?.credential_secret_id || !ws.enabled) {
      return new Response(
        JSON.stringify({ error: "Workspace not found, disabled, or secret reference missing" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: secretData, error: secretErr } = await serviceClient.rpc(
      "crisp_get_workspace_secret",
      {
        p_secret_id: ws.credential_secret_id,
      },
    );

    const tokenId =
      (secretData as Record<string, unknown>)?.token_id ||
      (secretData as Record<string, unknown>)?.tokenId;
    const tokenKey =
      (secretData as Record<string, unknown>)?.token_key ||
      (secretData as Record<string, unknown>)?.tokenKey;

    if (secretErr || !tokenId || !tokenKey) {
      return new Response(JSON.stringify({ error: "Vault credentials missing or invalid" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Call Crisp REST API — correct documented payload for acknowledging visitor messages
    //    PATCH /v1/website/{website_id}/conversation/{session_id}/read
    //    Body: { "from": "user", "origin": "chat" }
    const auth = btoa(`${tokenId}:${tokenKey}`);
    const crispRes = await crispFetch(
      serviceClient,
      `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/read`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Basic ${auth}`,
          "X-Crisp-Tier": "website",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: "user", origin: "chat" }),
      },
    );

    if (!crispRes.ok) {
      const errJson = await crispRes.json().catch(() => ({}));
      const reason =
        (errJson as Record<string, unknown>)?.reason ||
        ((errJson as Record<string, unknown>)?.data as Record<string, unknown>)?.message ||
        `HTTP ${crispRes.status}`;
      console.error(`Crisp mark-read API failed for session ${sessionId}:`, reason);
      return new Response(JSON.stringify({ error: `Crisp API error: ${reason}` }), {
        status: crispRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Update Supabase crisp_conversations: unread_count = 0, last_customer_unread_at = null
    const { error: updErr } = await serviceClient.rpc("crisp_mark_read_local", {
      p_conversation_id: conversationId,
      p_observed_at: observedAt,
    });

    if (updErr) {
      console.error("crisp-mark-read: DB update failed:", updErr.message);
      return new Response(JSON.stringify({ error: `Database update failed: ${updErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ status: "success", session_id: sessionId, website_id: websiteId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    console.error("Crisp mark-read error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
