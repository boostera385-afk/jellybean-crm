import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { crispFetch, type RpcClient } from "../_shared/crisp-api.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function resolveWorkspaceName(
  supabase: RpcClient,
  websiteId: string,
  authString: string,
): Promise<string | null> {
  try {
    const res = await crispFetch(supabase, `https://api.crisp.chat/v1/website/${websiteId}`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${authString}`,
        "X-Crisp-Tier": "website",
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.name || null;
  } catch {
    return null;
  }
}

/** Check if a message is a masked/redacted Crisp free-plan placeholder (e.g. 'xxxxx', 'xx xxxx xxxx') */
function isCrispMaskedMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  // Remove whitespace and common punctuation symbols
  const stripped = trimmed.replace(/[\s\p{P}\p{S}]/gu, "");
  // Must have at least 3 characters and consist entirely of 'x' or 'X'
  return stripped.length >= 3 && /^x+$/i.test(stripped);
}

/**
 * Coerce an untyped Crisp timestamp to epoch milliseconds.
 * Crisp returns `timestamp` as epoch ms, but the payload is untyped JSON, so
 * every read of it must be narrowed before it is compared or passed to `Date`.
 */
function toTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** Parse raw message content for any message type. */
function parseMessageContent(msg: Record<string, unknown>): string {
  const rawContent = msg.content;
  if (typeof rawContent === "string" && rawContent.trim()) return rawContent.trim();
  if (rawContent && typeof rawContent === "object") {
    const rc = rawContent as Record<string, unknown>;
    if (typeof rc.text === "string" && rc.text.trim()) return rc.text.trim();
    if (typeof rc.name === "string" && rc.name.trim()) return rc.name.trim();
  }
  if (msg.type === "file" || msg.type === "attachment") return "[File]";
  if (
    msg.type === "animation" ||
    msg.type === "picker" ||
    msg.type === "image" ||
    msg.type === "media"
  )
    return "[Image]";
  if (msg.type === "audio") return "[Audio]";
  return "[Attachment]";
}

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

    const body = await req.json().catch(() => ({}));
    const targetWebsiteId = body.websiteId ? String(body.websiteId).trim() : null;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) return new Response("Unauthorized", { status: 401 });
    const { data: roles, error: roleError } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    if (
      roleError ||
      !roles?.some((row: { role: string }) => ["admin", "cs_admin", "cs"].includes(row.role))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    // Fetch registered and enabled workspaces only
    let wsQuery = supabase
      .from("crisp_workspaces")
      .select("id, crisp_website_id, workspace_name, credential_secret_id")
      .eq("enabled", true);

    if (targetWebsiteId) {
      wsQuery = wsQuery.eq("crisp_website_id", targetWebsiteId);
    }

    const { data: workspaces, error: wsErr } = await wsQuery;

    if (wsErr || !workspaces || workspaces.length === 0) {
      return new Response(JSON.stringify({ error: "No enabled Crisp workspaces found to sync" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalConversations = 0;
    let totalMessages = 0;
    const syncErrors: { websiteId: string; workspaceName?: string; error: string }[] = [];

    for (const ws of workspaces) {
      const websiteId = ws.crisp_website_id;
      const secretId = ws.credential_secret_id;
      if (!secretId) {
        syncErrors.push({
          websiteId,
          workspaceName: ws.workspace_name || undefined,
          error: "No credentials secret ID found",
        });
        continue;
      }

      try {
        const { data: secretData, error: secretErr } = await supabase.rpc(
          "crisp_get_workspace_secret",
          {
            p_secret_id: secretId,
          },
        );

        const tokenId =
          (secretData as Record<string, unknown>)?.token_id ||
          (secretData as Record<string, unknown>)?.tokenId;
        const tokenKey =
          (secretData as Record<string, unknown>)?.token_key ||
          (secretData as Record<string, unknown>)?.tokenKey;

        if (secretErr || !tokenId || !tokenKey) {
          console.error(`Missing Vault credentials for workspace ${websiteId}`);
          syncErrors.push({
            websiteId,
            workspaceName: ws.workspace_name || undefined,
            error: "Missing Vault credentials",
          });
          continue;
        }

        const authString = btoa(`${tokenId}:${tokenKey}`);
        const headers = {
          Authorization: `Basic ${authString}`,
          "X-Crisp-Tier": "website",
          "Content-Type": "application/json",
        };

        // Resolve workspace name if missing
        if (!ws.workspace_name) {
          const wsName = await resolveWorkspaceName(supabase, websiteId, authString);
          if (wsName) {
            await supabase
              .from("crisp_workspaces")
              .update({ workspace_name: wsName })
              .eq("id", ws.id);
          }
        }

        let wsConversations = 0;
        let wsMessages = 0;

        // Paginate Crisp history (safety cap: 10 pages per sync)
        for (let page = 1; page <= 10; page++) {
          const listUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversations/${page}`;
          const listRes = await crispFetch(supabase, listUrl, { headers });
          if (!listRes.ok) {
            const errJson = await listRes.json().catch(() => ({}));
            const reason = String(
              (errJson as Record<string, unknown>)?.reason ||
                ((errJson as Record<string, unknown>)?.data as Record<string, unknown>)?.message ||
                `HTTP ${listRes.status}`,
            );
            console.error(
              `Crisp history sync failed for workspace ${websiteId} on page ${page}: ${reason}`,
            );
            syncErrors.push({
              websiteId,
              workspaceName: ws.workspace_name || undefined,
              error: reason,
            });
            break; // Stop paginating this failed workspace and continue with others
          }

          const listData = await listRes.json();
          const sessions = listData.data || [];
          if (!Array.isArray(sessions) || sessions.length === 0) break;

          // Process sessions in parallel chunks of 5
          const SESSION_CHUNK = 5;
          for (let sIdx = 0; sIdx < sessions.length; sIdx += SESSION_CHUNK) {
            const sessionSlice = sessions.slice(sIdx, sIdx + SESSION_CHUNK);
            const results = await Promise.allSettled(
              sessionSlice.map(async (session: Record<string, unknown>) => {
                const sessionId = session.session_id as string;
                if (!sessionId) return;

                const customerMeta = (session.meta as Record<string, unknown>) || {};
                const incomingName = customerMeta.nickname || session.nickname || null;
                const incomingEmail = customerMeta.email || session.email || null;
                const incomingPhone = customerMeta.phone || session.phone || null;
                const incomingAvatar = customerMeta.avatar || session.avatar || null;
                const state = session.state || "unresolved";

                const { data: existingConv } = await supabase
                  .from("crisp_conversations")
                  .select(
                    "customer_name, customer_email, customer_phone, customer_avatar, last_message, last_message_at, last_customer_unread_at",
                  )
                  .eq("crisp_website_id", websiteId)
                  .eq("crisp_session_id", sessionId)
                  .maybeSingle();

                const finalName = incomingName || existingConv?.customer_name || null;
                const finalEmail = incomingEmail || existingConv?.customer_email || null;
                const finalPhone = incomingPhone || existingConv?.customer_phone || null;
                const finalAvatar = incomingAvatar || existingConv?.customer_avatar || null;

                const { data: convRecord, error: convErr } = await supabase
                  .from("crisp_conversations")
                  .upsert(
                    {
                      crisp_website_id: websiteId,
                      crisp_session_id: sessionId,
                      customer_name: finalName,
                      customer_email: finalEmail,
                      customer_phone: finalPhone,
                      customer_avatar: finalAvatar,
                      status: state,
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: "crisp_website_id,crisp_session_id" },
                  )
                  .select("id")
                  .single();

                if (convErr || !convRecord) return;
                wsConversations++;

                // Sync messages for this conversation
                const msgsUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/messages`;
                const msgsRes = await crispFetch(supabase, msgsUrl, { headers });

                if (msgsRes.ok) {
                  const msgsData = await msgsRes.json();
                  const messagesList: Record<string, unknown>[] = msgsData.data || [];

                  if (messagesList.length > 0) {
                    // Sort messages chronologically ascending for correct ordering
                    messagesList.sort(
                      (a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp),
                    );

                    // Upsert all messages (ignore duplicates via 23505)
                    for (const msg of messagesList) {
                      const textContent = parseMessageContent(msg);
                      const msgTs = toTimestamp(msg.timestamp);
                      const crispMsgId = String(msg.fingerprint || `${sessionId}_${msgTs}`);
                      const isOperator = String(msg.from).toLowerCase() === "operator";
                      const sentAt = msgTs
                        ? new Date(msgTs).toISOString()
                        : new Date().toISOString();

                      const { data: imported, error: msgErr } = await supabase.rpc(
                        "crisp_import_messages",
                        {
                          p_rows: [
                            {
                              conversation_id: convRecord.id,
                              crisp_website_id: websiteId,
                              crisp_session_id: sessionId,
                              crisp_message_id: crispMsgId,
                              sender_type: isOperator ? "operator" : "customer",
                              direction: isOperator ? "outgoing" : "incoming",
                              content: textContent,
                              message_type: msg.type || "text",
                              sent_at: sentAt,
                              raw_payload: msg,
                            },
                          ],
                        },
                      );

                      // 23505 = unique_violation (already imported) — safe to ignore
                      if (msgErr) throw new Error(msgErr.message);
                      wsMessages += Number(imported) || 0;
                    }

                    // Transactional ingestion owns message ordering/unread state.
                  } else {
                    // Empty remote history does not establish absence locally.
                  }
                }
              }),
            );
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
          }
        }

        const { error: wsUpdateErr } = await supabase
          .from("crisp_workspaces")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", ws.id);

        if (wsUpdateErr) {
          console.error(
            `Failed to update last_synced_at for workspace ${websiteId}:`,
            wsUpdateErr.message,
          );
        }

        totalConversations += wsConversations;
        totalMessages += wsMessages;
      } catch (wsErr: unknown) {
        console.error(`Error processing workspace ${websiteId}:`, wsErr);
        syncErrors.push({
          websiteId,
          workspaceName: ws.workspace_name || undefined,
          error: wsErr instanceof Error ? wsErr.message : "Sync failed",
        });
      }
    }

    return new Response(
      JSON.stringify({
        status: "success",
        synced_conversations: totalConversations,
        synced_messages: totalMessages,
        errors: syncErrors.length > 0 ? syncErrors : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    console.error("Crisp history sync fatal error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
