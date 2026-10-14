import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { crispFetch } from "../_shared/crisp-api.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = ["admin", "cs_admin", "cs"];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: "Server configuration missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);

    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Role check
    const { data: userRoles, error: roleErr } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    if (roleErr) {
      return new Response(JSON.stringify({ error: "Could not verify user roles" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const roles = (userRoles || []).map((r: { role: string }) => r.role);
    if (!roles.some((r) => ALLOWED_ROLES.includes(r))) {
      return new Response(
        JSON.stringify({
          error: "Forbidden: Crisp Chat is restricted to admin, cs_admin, and cs roles.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const conversationId = body.conversation_id || body.conversationId;
    const content = String(body.content || "").trim();

    if (!conversationId || !content) {
      return new Response(
        JSON.stringify({ error: "conversation_id and non-empty content are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // FETCH FROM DATABASE: crisp_website_id and crisp_session_id
    const { data: conv, error: convErr } = await supabase
      .from("crisp_conversations")
      .select("id, crisp_website_id, crisp_session_id")
      .eq("id", conversationId)
      .single();

    if (convErr || !conv) {
      return new Response(JSON.stringify({ error: "Conversation not found in database" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const websiteId = conv.crisp_website_id;
    const sessionId = conv.crisp_session_id;

    // FIND WORKSPACE & VAULT CREDENTIALS
    const { data: wsRecord, error: wsErr } = await supabase
      .from("crisp_workspaces")
      .select("id, enabled, credential_secret_id")
      .eq("crisp_website_id", websiteId)
      .maybeSingle();

    if (wsErr || !wsRecord?.enabled || !wsRecord.credential_secret_id) {
      return new Response(
        JSON.stringify({
          error: "Workspace is missing, disabled, or not configured in Supabase Vault.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: secretData, error: secretErr } = await supabase.rpc(
      "crisp_get_workspace_secret",
      {
        p_secret_id: wsRecord.credential_secret_id,
      },
    );

    if (secretErr || !secretData?.token_id || !secretData?.token_key) {
      return new Response(
        JSON.stringify({
          error: `Workspace Vault credentials are unavailable: ${secretErr?.message ?? "missing token"}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const tokenId = secretData.token_id;
    const tokenKey = secretData.token_key;

    const authString = btoa(`${tokenId}:${tokenKey}`);
    const crispUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/message`;

    const crispResponse = await crispFetch(
      supabase,
      crispUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authString}`,
          "X-Crisp-Tier": "website",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "text",
          from: "operator",
          origin: "chat",
          content: content,
        }),
      },
      "interactive",
    );

    const responseData = await crispResponse.json().catch(() => ({}));

    if (!crispResponse.ok) {
      console.error("Crisp API Error:", crispResponse.status, responseData);
      const reason =
        responseData?.reason ||
        responseData?.data?.message ||
        responseData?.message ||
        `Crisp API status ${crispResponse.status}`;

      return new Response(JSON.stringify({ error: reason }), {
        status: crispResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const crispMsgData = responseData.data || responseData;
    const crispMsgId = crispMsgData.fingerprint == null ? null : String(crispMsgData.fingerprint);
    const sentAt = crispMsgData.timestamp
      ? new Date(crispMsgData.timestamp).toISOString()
      : new Date().toISOString();

    const { error: mirrorError } = await supabase.rpc("crisp_record_outgoing", {
      p_website_id: websiteId,
      p_session_id: sessionId,
      p_content: content,
      p_payload: responseData,
    });
    if (mirrorError)
      throw new Error("Crisp accepted this message but mirroring failed. Refresh before retrying.");

    return new Response(
      JSON.stringify({ status: "success", crisp_message_id: crispMsgId, sent_at: sentAt }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    console.error("Crisp send message error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
