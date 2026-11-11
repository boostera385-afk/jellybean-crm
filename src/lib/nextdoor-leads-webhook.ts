const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Webhook-Secret, X-Webhook-Token, X-Api-Key, X-Requested-With, Accept, Origin",
  "Access-Control-Max-Age": "86400",
};

import { extractNextdoorPostId, canonicalizeLeadLink } from "./lead-link-canonicalizer";

const SCHEMA_VERSION = "2026-04-08.nd.v1";

interface ExtRow {
  accountName?: string;
  subArea?: string;
  postDateTime?: string;
  postText?: string;
  profileLink?: string;
  postLink?: string;
  finalLink?: string;
  capturedDate?: string;
  capturedTime?: string;
  captureDateTime?: string;
  accountArea?: string;
  incogAccount?: string;
  postId?: string;
  sourceMode?: string;
  linkStatus?: string;
  linkAttempts?: number;
  [key: string]: unknown;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function toSheetRow(row: ExtRow): Record<string, string> {
  return {
    "Account Name": row.accountName || (row["Account Name"] as string) || "",
    "Sub Area / Neighborhood": row.subArea || (row["Sub Area / Neighborhood"] as string) || "",
    "Posted Date & Time": row.postDateTime || (row["Posted Date & Time"] as string) || "",
    "Post Text": row.postText || (row["Post Text"] as string) || "",
    "Lead Link":
      row.finalLink || row.postLink || row.profileLink || (row["Lead Link"] as string) || "",
    "Captured Date (UTC)": row.capturedDate || (row["Captured Date (UTC)"] as string) || "",
    "Captured Time (UTC)": row.capturedTime || (row["Captured Time (UTC)"] as string) || "",
    "Account Area": row.accountArea || (row["Account Area"] as string) || "",
    "Incog Account": row.incogAccount || (row["Incog Account"] as string) || "",
  };
}

function rowKey(row: ExtRow): string {
  if (row.postId) return row.postId;
  if (row.finalLink) return row.finalLink;
  if (row.postLink) return row.postLink;
  const name = row.accountName || (row["Account Name"] as string) || "";
  const posted = row.postDateTime || (row["Posted Date & Time"] as string) || "";
  const text = row.postText || (row["Post Text"] as string) || "";
  return `${name}|${posted}|${text.slice(0, 40)}`;
}

function capturedIso(row: ExtRow): string | null {
  const source =
    row.captureDateTime || row.capturedDate || row["Captured Date (UTC)"] || row["Captured Date"];
  if (!source) return new Date().toISOString(); // Fallback to current time so it stays at the top
  const time = Date.parse(String(source));
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function uniqueRows(rows: ExtRow[]) {
  const seen = new Set<string>();
  const unique: Array<{ key: string; row: ExtRow }> = [];
  const duplicateKeys: string[] = [];

  for (const row of rows) {
    const key = rowKey(row);
    if (seen.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    seen.add(key);
    unique.push({ key, row });
  }

  return { unique, duplicateKeys };
}

function normalizeIdentifier(value: string | null | undefined): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePostText(value: string | null | undefined): string {
  return (value || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePostedTime(value: string | null | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return String(parsed);
  return raw.toLowerCase().replace(/\s+/g, " ");
}

async function loadSupabaseAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function errorReason(error: unknown) {
  return error instanceof Error ? error.message : "server_error";
}

async function logWebhookActivity(action: string, metadata: Record<string, unknown>) {
  try {
    const supabaseAdmin = await loadSupabaseAdmin();
    await supabaseAdmin.from("activity_logs").insert({
      actor_id: null,
      actor_name: "Nextdoor Scraper Webhook",
      actor_role: "system",
      action,
      entity_type: "raw_lead_cache",
      metadata: metadata as never,
    });
  } catch (err) {
    console.error("[Nextdoor webhook] Failed to log activity:", err);
  }
}

function isLegacyExtensionRequest(
  request: Request,
  body: Record<string, unknown>,
  bodyParsed: boolean,
) {
  if (!bodyParsed || body.schemaVersion !== SCHEMA_VERSION) return false;

  const action = String(body.action ?? "");
  if (action !== "test_connection" && action !== "append_rows") return false;

  const origin = request.headers.get("Origin") || request.headers.get("origin") || "";
  const isBrowserExtension =
    origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");

  return isBrowserExtension;
}

export function handleNextdoorLeadsOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function handleNextdoorLeadsPost(request: Request) {
  try {
    // Fail-closed: require the secret env var to be present. Prefer
    // NEXTDOOR_WEBHOOK_SECRET; fall back to WEBHOOK_SECRET for legacy setups.
    const webhookSecret = process.env.NEXTDOOR_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
    // Accept the secret from any of the historical locations the extension
    // has used, so older builds keep working without a URL/config change:
    //   - X-Webhook-Secret / X-Webhook-Token / X-Api-Key headers
    //   - Authorization: Bearer <secret>
    //   - ?secret= / ?token= / ?key= query params
    //   - body fields: secret / token / apiKey / webhookSecret
    const url = new URL(request.url);
    const authHeader =
      request.headers.get("Authorization") || request.headers.get("authorization") || "";
    const bearer = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : authHeader.trim(); // some extensions send the raw secret with no "Bearer " prefix

    // Parse body once — we may need it for both auth and payload processing.
    let body: Record<string, unknown> = {};
    let bodyParsed = false;
    try {
      body = (await request.json()) as Record<string, unknown>;
      bodyParsed = true;
    } catch {
      // Non-JSON or empty body — that's fine for auth (secret may be in header/query).
    }

    const bodySecret =
      (typeof body.secret === "string" && body.secret) ||
      (typeof body.token === "string" && body.token) ||
      (typeof body.apiKey === "string" && body.apiKey) ||
      (typeof body.webhookSecret === "string" && body.webhookSecret) ||
      "";

    const requestSecret =
      request.headers.get("X-Webhook-Secret") ||
      request.headers.get("x-webhook-secret") ||
      request.headers.get("X-Webhook-Token") ||
      request.headers.get("x-webhook-token") ||
      request.headers.get("X-Api-Key") ||
      request.headers.get("x-api-key") ||
      bearer ||
      url.searchParams.get("secret") ||
      url.searchParams.get("token") ||
      url.searchParams.get("key") ||
      bodySecret ||
      "";

    if (!webhookSecret) {
      console.error("[Nextdoor webhook] NEXTDOOR_WEBHOOK_SECRET is not configured");
      await logWebhookActivity("webhook_misconfigured", { reason: "secret_env_missing" });
      return json({ ok: false, reason: "server_misconfigured" }, 500);
    }

    const legacyExtensionAccepted =
      !requestSecret && isLegacyExtensionRequest(request, body, bodyParsed);

    let secretsMatch = legacyExtensionAccepted;
    if (requestSecret) {
      const a = Buffer.from(requestSecret);
      const b = Buffer.from(webhookSecret);
      if (a.length === b.length) {
        try {
          const { timingSafeEqual } = await import("crypto");
          secretsMatch = timingSafeEqual(a, b);
        } catch {
          secretsMatch = requestSecret === webhookSecret;
        }
      }
    }

    if (legacyExtensionAccepted) {
      await logWebhookActivity("webhook_legacy_extension_auth_accepted", {
        action: String(body.action ?? ""),
        origin: request.headers.get("Origin") || request.headers.get("origin") || "",
      });
    }

    if (!secretsMatch) {
      // Diagnostic: log which header/body keys arrived (names only, never values),
      // so we can pinpoint where the extension is putting the secret.
      const headerKeys: string[] = [];
      request.headers.forEach((_v, k) => headerKeys.push(k));
      const bodyKeys = bodyParsed ? Object.keys(body).slice(0, 30) : [];
      const queryKeys = Array.from(url.searchParams.keys());
      await logWebhookActivity("webhook_auth_failed", {
        reason: "secret_mismatch",
        received_present: !!requestSecret,
        header_keys: headerKeys,
        body_keys: bodyKeys,
        query_keys: queryKeys,
        authorization_present: !!authHeader,
        origin: request.headers.get("Origin") || request.headers.get("origin") || "",
      });
      return json({ ok: false, reason: "unauthorized" }, 401);
    }

    if (!bodyParsed) {
      await logWebhookActivity("webhook_parse_failed", { reason: "invalid_json" });

      return json({ ok: false, reason: "invalid_json" }, 400);
    }

    if (body.schemaVersion !== SCHEMA_VERSION) {
      await logWebhookActivity("webhook_schema_mismatch", {
        received: body.schemaVersion,
        expected: SCHEMA_VERSION,
      });
      return json({ ok: false, reason: "unsupported_schema_version" }, 400);
    }

    const action = String(body.action ?? "");

    if (action === "test_connection") {
      const supabaseAdmin = await loadSupabaseAdmin();
      const { error } = await supabaseAdmin
        .from("raw_lead_cache")
        .select("row_key", { count: "exact", head: true });
      if (error) {
        await logWebhookActivity("webhook_test_connection_failed", { error: error.message });
        return json({ schemaVersion: SCHEMA_VERSION, ok: false, reason: error.message }, 500);
      }
      await logWebhookActivity("webhook_test_connection_success", {});
      return json({ schemaVersion: SCHEMA_VERSION, ok: true, status: "ok" });
    }

    if (action !== "append_rows") {
      await logWebhookActivity("webhook_unknown_action", { action });
      return json({ ok: false, reason: "unknown_action" }, 400);
    }

    const rawRows = Array.isArray(body.rows) ? (body.rows as ExtRow[]) : [];
    if (rawRows.length === 0) {
      await logWebhookActivity("webhook_no_rows", {});
      return json({ ok: false, reason: "no_rows" }, 400);
    }
    if (rawRows.length > 500) {
      await logWebhookActivity("webhook_too_many_rows", { count: rawRows.length });
      return json({ ok: false, reason: "too_many_rows" }, 400);
    }

    const supabaseAdmin = await loadSupabaseAdmin();
    const { unique, duplicateKeys } = uniqueRows(rawRows);
    const payload = unique.map(({ key, row }) => {
      const rawLink = row.finalLink || row.postLink || row.profileLink || null;
      return {
        row_key: key,
        data: toSheetRow(row),
        lead: null,
        captured_at: capturedIso(row),
        lead_link: rawLink,
        sheet_row: null,
        canonical_post_id: extractNextdoorPostId(rawLink),
        canonical_lead_link: canonicalizeLeadLink(rawLink),
        duplicate_detected: false,
        duplicate_reason: null as string | null,
        duplicate_match_type: null as string | null,
        duplicate_key: null as string | null,
        duplicate_of_raw_lead_id: null as string | null,
        duplicate_of_qualified_lead_id: null as string | null,
        duplicate_snapshot: null as Record<string, string | null> | null,
      };
    });

    const chunkSize = 100;
    const acceptedIds: string[] = [];
    const dbSkippedIds: string[] = [];

    for (let index = 0; index < payload.length; index += chunkSize) {
      const slice = payload.slice(index, index + chunkSize);
      const keys = unique.slice(index, index + chunkSize).map(({ key }) => key);

      // --- DUPLICATE DETECTION START ---
      const postIds = Array.from(
        new Set(slice.map((r) => r.canonical_post_id).filter(Boolean)),
      ) as string[];
      const leadLinks = Array.from(
        new Set(slice.map((r) => r.canonical_lead_link).filter(Boolean)),
      ) as string[];

      let existingRawPostIdRows: Array<{
        id: string;
        canonical_post_id?: string | null;
        canonical_lead_link?: string | null;
        row_key?: string | null;
        category?: string | null;
        captured_at?: string | null;
        assigned_myself_at?: string | null;
      }> = [];
      let existingRawLinkRows: Array<{
        id: string;
        canonical_post_id?: string | null;
        canonical_lead_link?: string | null;
        row_key?: string | null;
        category?: string | null;
        captured_at?: string | null;
        assigned_myself_at?: string | null;
      }> = [];
      let existingQualPostIdRows: Array<{
        id: string;
        canonical_post_id?: string | null;
        canonical_lead_link?: string | null;
        customer_name?: string | null;
        sub_area?: string | null;
        post_text?: string | null;
        cs_status?: string | null;
        created_at?: string | null;
        assigned_at?: string | null;
      }> = [];
      let existingQualLinkRows: Array<{
        id: string;
        canonical_post_id?: string | null;
        canonical_lead_link?: string | null;
        customer_name?: string | null;
        sub_area?: string | null;
        post_text?: string | null;
        cs_status?: string | null;
        created_at?: string | null;
        assigned_at?: string | null;
      }> = [];

      // Bulk queries against raw_lead_cache
      if (postIds.length > 0) {
        const { data } = await supabaseAdmin
          .from("raw_lead_cache")
          .select(
            "id, canonical_post_id, canonical_lead_link, row_key, data, category, captured_at, assigned_myself_at",
          )
          .in("canonical_post_id", postIds);
        if (data) existingRawPostIdRows = data;
      }
      if (leadLinks.length > 0) {
        const { data } = await supabaseAdmin
          .from("raw_lead_cache")
          .select(
            "id, canonical_post_id, canonical_lead_link, row_key, data, category, captured_at, assigned_myself_at",
          )
          .in("canonical_lead_link", leadLinks);
        if (data) existingRawLinkRows = data;
      }

      // Bulk queries against qualified_leads
      if (postIds.length > 0) {
        const { data } = await supabaseAdmin
          .from("qualified_leads")
          .select(
            "id, canonical_post_id, canonical_lead_link, customer_name, sub_area, post_text, cs_status, created_at, assigned_at",
          )
          .in("canonical_post_id", postIds);
        if (data) existingQualPostIdRows = data;
      }
      if (leadLinks.length > 0) {
        const { data } = await supabaseAdmin
          .from("qualified_leads")
          .select(
            "id, canonical_post_id, canonical_lead_link, customer_name, sub_area, post_text, cs_status, created_at, assigned_at",
          )
          .in("canonical_lead_link", leadLinks);
        if (data) existingQualLinkRows = data;
      }

      // Track same-batch first-occurrences by canonical key, so a later row in
      // the same chunk with the same post ID / canonical link is flagged as
      // duplicate. Stores the row_key of the first occurrence; we resolve it
      // to a real raw_lead_cache id after the upsert.
      const batchByPostId = new Map<string, string>();
      const batchByLink = new Map<string, string>();
      const pendingBatchRefs: Array<{ row_key: string; first_row_key: string }> = [];

      // Build a snapshot of an existing raw or qualified match. Kept narrow —
      // used later only when the original referenced row can no longer be
      // resolved and no exact replacement exists.
      function snapshotFromRaw(rec: {
        data?: Record<string, string> | null;
        category?: string | null;
        captured_at?: string | null;
        assigned_myself_at?: string | null;
        canonical_post_id?: string | null;
        canonical_lead_link?: string | null;
      }): Record<string, string | null> {
        const c = (rec.category || "").toLowerCase();
        const loc =
          c === "forwarded"
            ? "Forwarded"
            : c === "wrong"
              ? "Wrong Post"
              : c === "not_found"
                ? "Number Not Found"
                : c === "duplicate"
                  ? "Duplicate"
                  : !c
                    ? rec.assigned_myself_at
                      ? "Assigned Myself"
                      : "New"
                    : c;
        return {
          source: "raw",
          account_name: rec.data?.["Account Name"] ?? null,
          sub_area: rec.data?.["Sub Area / Neighborhood"] ?? null,
          posted_date_time: rec.data?.["Posted Date & Time"] ?? null,
          post_text: rec.data?.["Post Text"] ?? null,
          original_category: rec.category ?? null,
          original_location: loc,
          canonical_post_id: rec.canonical_post_id ?? null,
          canonical_lead_link: rec.canonical_lead_link ?? null,
          captured_at: rec.captured_at ?? null,
        };
      }
      function snapshotFromQualified(rec: {
        customer_name?: string | null;
        sub_area?: string | null;
        post_text?: string | null;
        cs_status?: string | null;
        canonical_post_id?: string | null;
        canonical_lead_link?: string | null;
        created_at?: string | null;
        assigned_at?: string | null;
      }): Record<string, string | null> {
        return {
          source: "qualified",
          account_name: rec.customer_name ?? null,
          sub_area: rec.sub_area ?? null,
          posted_date_time: null,
          post_text: rec.post_text ?? null,
          original_category: "forwarded",
          original_location: rec.cs_status
            ? `Forwarded to CS · ${rec.cs_status}`
            : "Forwarded to CS",
          canonical_post_id: rec.canonical_post_id ?? null,
          canonical_lead_link: rec.canonical_lead_link ?? null,
          captured_at: rec.assigned_at ?? rec.created_at ?? null,
        };
      }

      for (const row of slice) {
        let isDup = false;

        // Priority 1: Canonical Post ID Match (existing qualified, then existing raw)
        if (!isDup && row.canonical_post_id) {
          const qMatch = existingQualPostIdRows.find(
            (q) => q.canonical_post_id === row.canonical_post_id,
          );
          if (qMatch) {
            isDup = true;
            row.duplicate_detected = true;
            row.duplicate_reason = "Same Nextdoor post ID (already forwarded)";
            row.duplicate_match_type = "post_id";
            row.duplicate_key = row.canonical_post_id;
            row.duplicate_of_qualified_lead_id = qMatch.id;
            row.duplicate_snapshot = snapshotFromQualified(qMatch);
          } else {
            const rMatch = existingRawPostIdRows.find(
              (r) => r.canonical_post_id === row.canonical_post_id && r.row_key !== row.row_key,
            );
            if (rMatch) {
              isDup = true;
              row.duplicate_detected = true;
              row.duplicate_reason = "Same Nextdoor post ID";
              row.duplicate_match_type = "post_id";
              row.duplicate_key = row.canonical_post_id;
              row.duplicate_of_raw_lead_id = rMatch.id;
              row.duplicate_snapshot = snapshotFromRaw(rMatch);
            }
          }
        }

        // Priority 2: Canonical Lead Link Match (existing qualified, then existing raw)
        if (!isDup && row.canonical_lead_link) {
          const qMatch = existingQualLinkRows.find(
            (q) => q.canonical_lead_link === row.canonical_lead_link,
          );
          if (qMatch) {
            isDup = true;
            row.duplicate_detected = true;
            row.duplicate_reason = "Same canonical post link (already forwarded)";
            row.duplicate_match_type = "canonical_link";
            row.duplicate_key = row.canonical_lead_link;
            row.duplicate_of_qualified_lead_id = qMatch.id;
            row.duplicate_snapshot = snapshotFromQualified(qMatch);
          } else {
            const rMatch = existingRawLinkRows.find(
              (r) => r.canonical_lead_link === row.canonical_lead_link && r.row_key !== row.row_key,
            );
            if (rMatch) {
              isDup = true;
              row.duplicate_detected = true;
              row.duplicate_reason = "Same canonical post link";
              row.duplicate_match_type = "canonical_link";
              row.duplicate_key = row.canonical_lead_link;
              row.duplicate_of_raw_lead_id = rMatch.id;
              row.duplicate_snapshot = snapshotFromRaw(rMatch);
            }
          }
        }

        // Same-batch dedup: process rows in order — first occurrence stays the
        // original, later occurrences with the same canonical key are marked.
        if (!isDup && row.canonical_post_id) {
          const firstKey = batchByPostId.get(row.canonical_post_id);
          if (firstKey && firstKey !== row.row_key) {
            isDup = true;
            row.duplicate_detected = true;
            row.duplicate_reason = "Same Nextdoor post ID (same import batch)";
            row.duplicate_match_type = "post_id";
            row.duplicate_key = row.canonical_post_id;
            pendingBatchRefs.push({ row_key: row.row_key, first_row_key: firstKey });
            const firstRow = slice.find((s) => s.row_key === firstKey);
            if (firstRow) row.duplicate_snapshot = snapshotFromRaw(firstRow);
          } else if (!firstKey) {
            batchByPostId.set(row.canonical_post_id, row.row_key);
          }
        }
        if (!isDup && row.canonical_lead_link) {
          const firstKey = batchByLink.get(row.canonical_lead_link);
          if (firstKey && firstKey !== row.row_key) {
            isDup = true;
            row.duplicate_detected = true;
            row.duplicate_reason = "Same canonical post link (same import batch)";
            row.duplicate_match_type = "canonical_link";
            row.duplicate_key = row.canonical_lead_link;
            pendingBatchRefs.push({ row_key: row.row_key, first_row_key: firstKey });
            const firstRow = slice.find((s) => s.row_key === firstKey);
            if (firstRow) row.duplicate_snapshot = snapshotFromRaw(firstRow);
          } else if (!firstKey) {
            batchByLink.set(row.canonical_lead_link, row.row_key);
          }
        }
      }

      // Priority 3: Fallback — all four fields must match exactly (normalized)
      // when neither canonical_post_id nor canonical_lead_link produced a hit.
      // Narrow candidates via a single bulk query keyed by "Posted Date & Time"
      // (highly selective, avoids full-table scan of raw_lead_cache).
      const fallbackRows = slice.filter((r) => !r.duplicate_detected);
      const postedTimes = Array.from(
        new Set(
          fallbackRows
            .map((r) => (r.data["Posted Date & Time"] || "").trim())
            .filter((v) => v.length > 0),
        ),
      );
      let fallbackCandidates: Array<{
        id: string;
        row_key: string;
        data: Record<string, string>;
        category: string | null;
        captured_at: string | null;
        assigned_myself_at: string | null;
        canonical_post_id: string | null;
        canonical_lead_link: string | null;
      }> = [];
      if (postedTimes.length > 0) {
        // "Posted Date & Time" is usually relative ("15 hr ago"), so it matches
        // thousands of historical rows. Pull only the short key fields first,
        // then fetch full rows (with Post Text) for the few rows whose name,
        // area and posted time already match. Same result, a fraction of the
        // rows/bytes the database has to build and ship per batch.
        const { data: keyRows } = await supabaseAdmin
          .from("raw_lead_cache")
          .select(
            // JSON keys are quoted: supabase-js strips unquoted whitespace from select.
            'id, posted:data->>"Posted Date & Time", name:data->>"Account Name", area:data->>"Sub Area / Neighborhood"',
          )
          .in("data->>Posted Date & Time", postedTimes);
        const wanted = new Set(
          fallbackRows.map(
            (r) =>
              `${normalizePostedTime(r.data["Posted Date & Time"] || "")}|${normalizeIdentifier(
                r.data["Account Name"] || "",
              )}|${normalizeIdentifier(r.data["Sub Area / Neighborhood"] || "")}`,
          ),
        );
        const candidateIds = (
          (keyRows ?? []) as unknown as Array<{
            id: string;
            posted: string | null;
            name: string | null;
            area: string | null;
          }>
        )
          .filter((k) =>
            wanted.has(
              `${normalizePostedTime(k.posted || "")}|${normalizeIdentifier(
                k.name || "",
              )}|${normalizeIdentifier(k.area || "")}`,
            ),
          )
          .map((k) => k.id);
        if (candidateIds.length > 0) {
          const { data } = await supabaseAdmin
            .from("raw_lead_cache")
            .select(
              "id, row_key, data, category, captured_at, assigned_myself_at, canonical_post_id, canonical_lead_link",
            )
            .in("id", candidateIds);
          if (data) fallbackCandidates = data as never;
        }
      }

      if (fallbackCandidates.length > 0) {
        // Group candidates by normalized posted time for O(1) lookup.
        const byPosted = new Map<string, typeof fallbackCandidates>();
        for (const c of fallbackCandidates) {
          const key = normalizePostedTime(c.data?.["Posted Date & Time"] || "");
          if (!key) continue;
          const arr = byPosted.get(key) || [];
          arr.push(c);
          byPosted.set(key, arr);
        }

        for (const row of fallbackRows) {
          const postedKey = normalizePostedTime(row.data["Posted Date & Time"] || "");
          const nameKey = normalizeIdentifier(row.data["Account Name"] || "");
          const areaKey = normalizeIdentifier(row.data["Sub Area / Neighborhood"] || "");
          const textKey = normalizePostText(row.data["Post Text"] || "");
          if (!postedKey || !nameKey || !areaKey || !textKey) continue;

          const candidates = byPosted.get(postedKey);
          if (!candidates) continue;
          const match = candidates.find((c) => {
            if (c.row_key === row.row_key) return false;
            const cName = normalizeIdentifier(c.data?.["Account Name"] || "");
            const cArea = normalizeIdentifier(c.data?.["Sub Area / Neighborhood"] || "");
            const cText = normalizePostText(c.data?.["Post Text"] || "");
            return cName === nameKey && cArea === areaKey && cText === textKey;
          });
          if (match) {
            row.duplicate_detected = true;
            row.duplicate_reason = "Same account, area, posted time & post text";
            row.duplicate_match_type = "details_all_four";
            row.duplicate_key = `${nameKey}|${areaKey}|${postedKey}`;
            row.duplicate_of_raw_lead_id = match.id;
            row.duplicate_snapshot = snapshotFromRaw(match);
          }
        }
      }
      // --- FALLBACK DETECTION END ---
      // --- DUPLICATE DETECTION END ---

      const { error } = await supabaseAdmin
        .from("raw_lead_cache")
        .upsert(slice, { onConflict: "row_key", ignoreDuplicates: true });

      if (error) {
        await logWebhookActivity("webhook_upsert_failed", { error: error.message });
        return json({ ok: false, reason: error.message }, 500);
      }

      // Same-batch dedup: resolve the first-occurrence row_keys to real ids
      // and back-fill duplicate_of_raw_lead_id on the duplicate rows.
      if (pendingBatchRefs.length > 0) {
        const firstKeys = Array.from(new Set(pendingBatchRefs.map((p) => p.first_row_key)));
        const { data: firstRows } = await supabaseAdmin
          .from("raw_lead_cache")
          .select("id, row_key")
          .in("row_key", firstKeys);
        const keyToId = new Map((firstRows ?? []).map((r) => [r.row_key, r.id as string]));
        for (const ref of pendingBatchRefs) {
          const firstId = keyToId.get(ref.first_row_key);
          if (!firstId) continue;
          await supabaseAdmin
            .from("raw_lead_cache")
            .update({ duplicate_of_raw_lead_id: firstId })
            .eq("row_key", ref.row_key)
            .is("duplicate_of_raw_lead_id", null);
        }
      }

      // Determine which keys were actually inserted by checking which already existed
      const { data: existing } = await supabaseAdmin
        .from("raw_lead_cache")
        .select("row_key")
        .in("row_key", keys)
        .lt("created_at", new Date(Date.now() - 2000).toISOString());

      const existingSet = new Set((existing ?? []).map((r) => r.row_key));
      for (const key of keys) {
        if (existingSet.has(key)) dbSkippedIds.push(key);
        else acceptedIds.push(key);
      }
    }

    const skippedIds = [...dbSkippedIds, ...duplicateKeys];

    await logWebhookActivity("webhook_success", {
      added: acceptedIds.length,
      skipped: skippedIds.length,
      duplicate_keys: duplicateKeys.length,
      db_skipped_keys: dbSkippedIds.length,
    });

    return json({
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      status: "ok",
      added: acceptedIds.length,
      acceptedIds,
      skippedIds,
      skippedReasons: skippedIds.length > 0 ? { duplicate: skippedIds.length } : {},
    });
  } catch (error) {
    console.error("[Nextdoor webhook]", error);
    await logWebhookActivity("webhook_fatal_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return json({ schemaVersion: SCHEMA_VERSION, ok: false, reason: errorReason(error) }, 500);
  }
}
