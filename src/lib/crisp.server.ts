// Server-only Crisp helpers. These run inside the app server runtime and talk
// to the Crisp REST API directly using per-workspace credentials stored in Vault.
import { crispFetch } from "../../supabase/functions/_shared/crisp-api";

/**
 * Query-builder shape used by the helpers below.
 *
 * Modelled with `interface` + `PromiseLike` because PostgREST builders are both
 * chainable and thenable: `.select(...).eq(...).eq(...).maybeSingle()` must
 * keep chaining, while `await client.from(t).upsert(rows).select("id")` must
 * resolve to `{ data, error }`. Return types are intentionally loose — matching
 * a real `SupabaseClient<Database>` structurally would force TypeScript to
 * instantiate the entire generated schema and exhaust the instantiation depth.
 */
interface QueryBuilder extends PromiseLike<{
  data: { id: string }[] | null;
  error: Error | null;
}> {
  select: (cols?: string) => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: Error | null }>;
  single: () => Promise<{ data: { id: string } | null; error: Error | null }>;
  update: (data: unknown) => QueryBuilder;
  upsert: (data: unknown, opts?: unknown) => QueryBuilder;
}

type AnyClient = {
  from: (t: string) => QueryBuilder;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: Record<string, unknown> | null; error: Error | null }>;
};

export type CrispCreds = { tokenId: string; tokenKey: string };

export async function markCrispReadLocal(
  admin: AnyClient,
  conversationId: string,
  observedAt: string,
) {
  const { error } = await admin.rpc("crisp_mark_read_local", {
    p_conversation_id: conversationId,
    p_observed_at: observedAt,
  });
  if (error) throw new Error(`Could not mark conversation read: ${error.message}`);
}

export async function recordCrispOutgoing(
  admin: AnyClient,
  websiteId: string,
  sessionId: string,
  content: string,
  payload: unknown,
) {
  const { data, error } = await admin.rpc("crisp_record_outgoing", {
    p_website_id: websiteId,
    p_session_id: sessionId,
    p_content: content,
    p_payload: payload,
  });
  if (error)
    throw new Error(
      "Message was accepted by Crisp but could not be mirrored. Refresh before retrying.",
    );
  return data as unknown as string;
}

export function crispHeaders(creds: CrispCreds) {
  const auth = btoa(`${creds.tokenId}:${creds.tokenKey}`);
  return {
    Authorization: `Basic ${auth}`,
    "X-Crisp-Tier": "website",
    "Content-Type": "application/json",
  };
}

export async function crispErrorReason(res: Response) {
  const json = (await res.json().catch(() => ({}))) as {
    reason?: string;
    message?: string;
    data?: { message?: string };
  } & Record<string, unknown>;
  return json?.reason || json?.data?.message || json?.message || `HTTP ${res.status}`;
}

/** Read a workspace's Crisp credentials out of Vault. */
export async function getWorkspaceCreds(
  admin: AnyClient,
  secretId: string,
): Promise<{ ok: true; creds: CrispCreds } | { ok: false; error: string }> {
  const { data, error } = await admin.rpc("crisp_get_workspace_secret", { p_secret_id: secretId });
  const tokenId = data?.token_id ?? data?.tokenId;
  const tokenKey = data?.token_key ?? data?.tokenKey;
  if (error || !tokenId || !tokenKey) {
    return {
      ok: false,
      error: `Workspace credentials unavailable: ${error?.message ?? "missing token"}`,
    };
  }
  return { ok: true, creds: { tokenId: String(tokenId), tokenKey: String(tokenKey) } };
}

/** Crisp free-plan masked placeholder message, e.g. "xxx xxxx". */
export function isCrispMaskedMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const stripped = content.trim().replace(/[\s\p{P}\p{S}]/gu, "");
  return stripped.length >= 3 && /^x+$/i.test(stripped);
}

export function parseMessageContent(msg: Record<string, unknown>): string {
  const raw = msg?.content;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    // Crisp attachment payloads arrive as untyped JSON; narrow before reading.
    const parts = raw as Record<string, unknown>;
    if (typeof parts.text === "string" && parts.text.trim()) return parts.text.trim();
    if (typeof parts.name === "string" && parts.name.trim()) return parts.name.trim();
  }
  const type = msg?.type;
  if (type === "file" || type === "attachment") return "[File]";
  if (type === "animation" || type === "picker" || type === "image" || type === "media")
    return "[Image]";
  if (type === "audio") return "[Audio]";
  return "[Attachment]";
}

/** Sync one Crisp workspace's recent conversations + messages into Supabase. */
export async function syncWorkspace(
  admin: AnyClient,
  ws: {
    id: string;
    crisp_website_id: string;
    workspace_name: string | null;
    credential_secret_id: string | null;
  },
  opts: { maxPages: number },
): Promise<{ conversations: number; messages: number; error?: string }> {
  const websiteId = ws.crisp_website_id;
  if (!ws.credential_secret_id)
    return { conversations: 0, messages: 0, error: "No stored credentials for workspace" };

  const credsRes = await getWorkspaceCreds(admin, ws.credential_secret_id);
  if (!credsRes.ok) return { conversations: 0, messages: 0, error: credsRes.error };
  const headers = crispHeaders(credsRes.creds);

  let conversations = 0;
  let messages = 0;

  if (!ws.workspace_name) {
    try {
      const infoRes = await crispFetch(admin, `https://api.crisp.chat/v1/website/${websiteId}`, {
        headers,
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as { data?: { name?: string } } & Record<
          string,
          unknown
        >;
        const name = info?.data?.name;
        if (name)
          await admin.from("crisp_workspaces").update({ workspace_name: name }).eq("id", ws.id);
      }
    } catch {
      // Non-fatal
    }
  }

  for (let page = 1; page <= opts.maxPages; page++) {
    const listRes = await crispFetch(
      admin,
      `https://api.crisp.chat/v1/website/${websiteId}/conversations/${page}`,
      { headers },
    );
    if (!listRes.ok) {
      return { conversations, messages, error: await crispErrorReason(listRes) };
    }
    const listJson = (await listRes.json()) as { data?: Record<string, unknown>[] } & Record<
      string,
      unknown
    >;
    const sessions = (Array.isArray(listJson?.data) ? listJson.data : []) as Array<
      {
        session_id?: string;
        meta?: Record<string, unknown>;
        nickname?: string;
        email?: string;
        phone?: string;
        avatar?: string;
        state?: string;
      } & Record<string, unknown>
    >;
    if (sessions.length === 0) break;

    const CHUNK = 5;
    for (let i = 0; i < sessions.length; i += CHUNK) {
      const results = await Promise.allSettled(
        sessions.slice(i, i + CHUNK).map(async (session) => {
          const sessionId = session?.session_id;
          if (!sessionId) return;
          const meta = session.meta || {};

          const { data: existing } = await admin
            .from("crisp_conversations")
            .select("customer_name, customer_email, customer_phone, customer_avatar")
            .eq("crisp_website_id", websiteId)
            .eq("crisp_session_id", sessionId)
            .maybeSingle();

          const { data: conv, error: convErr } = await admin
            .from("crisp_conversations")
            .upsert(
              {
                crisp_website_id: websiteId,
                crisp_session_id: sessionId,
                customer_name: meta.nickname || session.nickname || existing?.customer_name || null,
                customer_email: meta.email || session.email || existing?.customer_email || null,
                customer_phone: meta.phone || session.phone || existing?.customer_phone || null,
                customer_avatar: meta.avatar || session.avatar || existing?.customer_avatar || null,
                status: session.state || "unresolved",
                updated_at: new Date().toISOString(),
              },
              { onConflict: "crisp_website_id,crisp_session_id" },
            )
            .select("id")
            .single();

          if (convErr || !conv) return;
          conversations++;

          const msgsRes = await crispFetch(
            admin,
            `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/messages`,
            { headers },
          );
          if (!msgsRes.ok) return;
          const msgsJson = (await msgsRes.json()) as { data?: Record<string, unknown>[] } & Record<
            string,
            unknown
          >;
          const list = (Array.isArray(msgsJson?.data) ? msgsJson.data : []) as Array<
            { from?: string; timestamp?: number; type?: string; fingerprint?: string } & Record<
              string,
              unknown
            >
          >;

          if (list.length === 0) {
            // An empty/limited remote history cannot erase a newer local message.
            return;
          }

          list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

          const rows = list.map((msg) => {
            const isOperator = String(msg.from).toLowerCase() === "operator";
            return {
              conversation_id: conv.id,
              crisp_website_id: websiteId,
              crisp_session_id: sessionId,
              crisp_message_id: String(msg.fingerprint || `${sessionId}_${msg.timestamp}`),
              sender_type: isOperator ? "operator" : "customer",
              direction: isOperator ? "outgoing" : "incoming",
              content: parseMessageContent(msg),
              message_type: msg.type || "text",
              sent_at: msg.timestamp
                ? new Date(msg.timestamp).toISOString()
                : new Date().toISOString(),
              raw_payload: msg,
            };
          });

          for (let offset = 0; offset < rows.length; offset += 500) {
            const { data, error } = await admin.rpc("crisp_import_messages", {
              p_rows: rows.slice(offset, offset + 500),
            });
            if (error) throw error;
            messages += Number(data) || 0;
          }
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }

  await admin
    .from("crisp_workspaces")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", ws.id);

  return { conversations, messages };
}
