import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivity } from "@/lib/activity-log";

// FROZEN PROMPT — batch-aware default used when no saved CRM prompt is available.
export const FROZEN_LEAD_PROMPT = `You classify each item in the \`leads\` array independently as a residential home-service lead.

For every input ID, return a \`yes\` or \`no\` decision using the required response schema.

YES means the author currently needs, wants, or is seeking someone to perform an included service at a home or residential property.

YES includes:
- Hiring or looking for a provider
- Asking for a recommendation, referral, estimate, or quote
- Describing a current home problem that normally requires professional help
- Repair, diagnosis, installation, replacement, maintenance, improvement, remodeling, moving, junk removal, hauling, or heavy one-time cleanup

Included services include handyman, plumbing, electrical, HVAC, roofing, gutters, flooring, drywall, painting, doors, windows, garage doors, fences, concrete, appliances, sprinklers, pools, remodeling, moving, junk removal, pest control, locksmith, tree removal or trimming, pressure washing, storm cleanup, hoarder cleanup, estate cleanout, and similar residential work.

NO means:
- The author is advertising or offering their own services
- The service has already been completed and no additional work is requested
- The author only wants DIY advice, products, supplies, moving boxes, or a disposal location
- The requested service is routine house cleaning, cooking, catering, beauty, child care, pet care, lawn mowing, routine landscaping, car repair, employment, rentals, events, or unrelated discussion

Important:
- Classify the author's intent, not isolated keywords.
- A current broken or malfunctioning home item is YES even without the words "hire," "recommend," or "looking for."
- "My AC stopped cooling" is YES.
- "I repair AC systems—call me" is NO.
- "I need movers" is YES.
- "I need moving boxes" is NO.
- If a post clearly contains both qualifying and unrelated requests, choose YES.
- When a post may reasonably be a qualifying residential-service need, choose YES.
- Do not allow one post in the batch to influence another post.`;

const analyzeInputSchema = z.object({
  // Accepted for backward-compat; if omitted the frozen default is used.
  prompt: z.string().optional(),
  rowKeys: z.array(z.string().min(1)).min(1).max(50),
});

type LeadDecision = "yes" | "no";

type RawLeadAiResult = {
  row_key: string;
  lead: LeadDecision;
};

// Nano models handle small batches more reliably. 10 keeps id-mapping tight.
const OPENAI_BATCH_SIZE = 10;
const MAX_POST_TEXT_CHARS = 1500;
const PRIMARY_MODEL = "gpt-5.4-nano-2026-03-17";

type OpenAiResponse = {
  id?: string;
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
  // Chat Completions shape
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null; role?: string };
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
  };
};

async function ensureRequesterCanAnalyze(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "sub_admin", "maturing"]);

  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Forbidden: Raw Leads access required");
}

async function loadActor(userId: string) {
  const [{ data: profile }, { data: roleRow }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("full_name, username, email")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin.from("user_roles").select("role").eq("user_id", userId).limit(1).maybeSingle(),
  ]);

  return {
    name: profile?.full_name || profile?.username || profile?.email || null,
    role: roleRow?.role ?? null,
  };
}

// Extracts completion text from OpenAI chat completions or legacy responses output
function extractOutputText(response: OpenAiResponse) {
  // Chat Completions (what this function calls) returns choices[].message.content
  const choice = response.choices?.[0];
  if (choice?.message?.refusal) {
    throw new Error(`OpenAI refused the request: ${choice.message.refusal}`);
  }
  const chatText = choice?.message?.content?.trim();
  if (chatText) return chatText;

  // Responses API fallback
  if (response.output_text) return response.output_text;

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function trimForAi(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_POST_TEXT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_POST_TEXT_CHARS)}...`;
}

// Strict parser + completeness validator. Throws on any anomaly rather than
// silently dropping a lead or defaulting a missing result to "no".
export function parseAndValidateAiResults(text: string, rowKeys: string[]): RawLeadAiResult[] {
  let parsed: { results?: Array<{ id?: unknown; lead?: unknown }> };
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`AI response is not valid JSON: ${(e as Error).message}`);
  }

  const results = parsed.results;
  if (!Array.isArray(results)) {
    throw new Error("AI response missing 'results' array");
  }

  const expectedIds = new Set(rowKeys.map((_, i) => String(i + 1)));
  const seen = new Set<string>();
  const out: RawLeadAiResult[] = [];

  for (const item of results) {
    if (typeof item.id !== "string" || !expectedIds.has(item.id)) {
      throw new Error(`AI returned unexpected or missing id: ${JSON.stringify(item.id)}`);
    }
    if (seen.has(item.id)) {
      throw new Error(`AI returned duplicate id: ${item.id}`);
    }
    if (item.lead !== "yes" && item.lead !== "no") {
      throw new Error(
        `AI returned invalid decision for id ${item.id}: ${JSON.stringify(item.lead)}`,
      );
    }
    seen.add(item.id);
    out.push({ row_key: rowKeys[Number(item.id) - 1], lead: item.lead });
  }

  if (seen.size !== rowKeys.length) {
    const missing = [...expectedIds].filter((id) => !seen.has(id));
    throw new Error(`AI response incomplete — missing ids: ${missing.join(", ")}`);
  }

  return out;
}

async function classifyWithOpenAi({
  systemPrompt,
  leads,
  model,
}: {
  systemPrompt: string;
  leads: Array<{ id: string; postText: string }>;
  model: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY secret");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ leads }) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "raw_lead_classification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    lead: { type: "string", enum: ["yes", "no"] },
                  },
                  required: ["id", "lead"],
                },
              },
            },
            required: ["results"],
          },
        },
      },
    }),
  });

  const body = (await response.json()) as OpenAiResponse;
  const openaiRequestId =
    response.headers.get("x-request-id") ?? response.headers.get("openai-request-id") ?? null;

  console.log("[raw-leads-ai] OpenAI response", {
    model,
    status: response.status,
    ok: response.ok,
    batchSize: leads.length,
    requestedCount: leads.length,
    openaiResponseId: body.id ?? null,
    openaiRequestId,
    error: body.error?.message ?? null,
  });

  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenAI request failed (${response.status})`);
  }

  const text = extractOutputText(body);
  if (!text) {
    throw new Error(
      `OpenAI returned an empty response (finish_reason: ${body.choices?.[0]?.finish_reason ?? "unknown"})`,
    );
  }
  return text;
}

async function classifyBatch({
  systemPrompt,
  batch,
}: {
  systemPrompt: string;
  batch: Array<{ rowKey: string; id: string; postText: string }>;
}): Promise<RawLeadAiResult[]> {
  const text = await classifyWithOpenAi({
    systemPrompt,
    model: PRIMARY_MODEL,
    leads: batch.map(({ id, postText }) => ({ id, postText: trimForAi(postText) })),
  });
  const rowKeys = batch.map((lead) => lead.rowKey);
  const results = parseAndValidateAiResults(text, rowKeys);
  console.log("[raw-leads-ai] batch validated", {
    requested: batch.length,
    returned: results.length,
    complete: results.length === batch.length,
  });
  return results;
}

export const analyzeRawLeadsWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => analyzeInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterCanAnalyze(context.userId);

    const orderedKeys = [...new Set(data.rowKeys)].slice(0, 50);

    // Chunk the .in() lookup — long row_keys can push the PostgREST GET URL
    // past its length limit and surface as a generic "Bad Request".
    const CHUNK = 10;
    const rows: Array<{ row_key: string; data: unknown; duplicate_detected: boolean | null }> = [];
    for (let i = 0; i < orderedKeys.length; i += CHUNK) {
      const slice = orderedKeys.slice(i, i + CHUNK);
      const { data: part, error } = await supabaseAdmin
        .from("raw_lead_cache")
        .select("row_key, data, duplicate_detected")
        .in("row_key", slice);
      if (error) throw new Error(error.message);
      if (part) rows.push(...part);
    }

    const byKey = new Map(rows.map((row) => [row.row_key, row]));
    const leads = orderedKeys
      .map((rowKey) => {
        const row = byKey.get(rowKey);
        const payload = (row?.data ?? {}) as Record<string, string | null | undefined>;
        return {
          rowKey,
          postText: payload["Post Text"] ?? "",
          isDuplicate: row?.duplicate_detected === true,
        };
      })
      // Skip duplicates — no point spending AI credits classifying them.
      .filter((lead) => !lead.isDuplicate)
      // Posts under 20 chars are too short for reliable AI classification.
      .filter((lead) => lead.postText.trim().length >= 20);

    if (leads.length === 0) throw new Error("No selected raw leads have post text to analyze");

    const systemPrompt = data.prompt?.trim() || FROZEN_LEAD_PROMPT;
    const results: RawLeadAiResult[] = [];
    for (let i = 0; i < leads.length; i += OPENAI_BATCH_SIZE) {
      const slice = leads.slice(i, i + OPENAI_BATCH_SIZE);
      const batch = slice.map((lead, idx) => ({
        rowKey: lead.rowKey,
        id: String(idx + 1),
        postText: lead.postText,
      }));
      const batchResults = await classifyBatch({ systemPrompt, batch });
      results.push(...batchResults);
    }

    if (results.length === 0) throw new Error("AI returned no usable lead decisions");

    const { error: updateError } = await supabaseAdmin.rpc("batch_update_raw_lead_decisions", {
      decisions: results.map(({ row_key, lead }) => ({ row_key, lead })),
    });
    if (updateError) throw new Error(updateError.message);

    const yes = results.filter((result) => result.lead === "yes").length;
    const no = results.filter((result) => result.lead === "no").length;
    const review = 0;
    const actor = await loadActor(context.userId);
    await logActivity({
      supabaseAdmin,
      actorId: context.userId,
      actorName: actor.name,
      actorRole: actor.role,
      action: "ai_classify",
      entityType: "raw_lead_cache",
      metadata: { analyzed: results.length, yes, no, review },
    });

    return {
      ok: true,
      analyzed: results.length,
      yes,
      no,
      review,
      results,
    };
  });

export const checkOpenAiConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "sub_admin"]);
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("Forbidden: admin only");

    return { configured: !!process.env.OPENAI_API_KEY };
  });

async function ensureRequesterCanRephrase(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", [
      "admin",
      "sub_admin",
      "cs_admin",
      "cs",
      "scraping",
      "maturing",
      "acc_handler",
      "facebook",
      "seo",
    ]);

  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Forbidden: Access required");
}

const rephraseInputSchema = z.object({
  leadId: z.string().uuid(),
});

const LEADING_VERB_RE = /^(share|let me know|send me|send|tell me|tell|confirm|provide)\b/i;
const QUESTION_WORD_RE = /^(what|when|where|which|who|how|whether|if|why)\b/;

/**
 * Legacy v1 compatibility helper. V2 renders complete standalone questions and
 * does not run this wording normalizer on generated replies.
 *
 * The 2026-10-16 live test surfaced two patterns the exemplars never show:
 * - a repeated leading verb across the pair ("share a picture of the doors and
 *   shutters and share your complete address", "let me know what issue you are
 *   facing and let me know the size of the freezer"), which reads like a chant;
 * - a second ask with no verb at all ("...and a picture of it"), which is
 *   broken in the "Could you kindly ... and ..." slot.
 * Elide the repeated verb, and give every ask a verb ("share" for objects,
 * "tell me" for question words).
 */
export function normalizeAdjacentRequirements(req1: string, req2: string): [string, string] {
  const ensureVerb = (r: string): string =>
    LEADING_VERB_RE.test(r) ? r : QUESTION_WORD_RE.test(r) ? `tell me ${r}` : `share ${r}`;

  let a = req1.trim();
  let b = req2.trim();
  if (!a || !b) return [a, b];

  a = ensureVerb(a);
  b = ensureVerb(b);
  const verbA = LEADING_VERB_RE.exec(a)?.[1];
  if (verbA && b.toLowerCase().startsWith(verbA.toLowerCase() + " ")) {
    b = b.slice(verbA.length + 1);
  }
  return [a, b];
}

export const rephraseLeadTemplateWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => rephraseInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterCanRephrase(context.userId);
    const { data: result, error } = await context.supabase.functions.invoke("cs-compose-lead", {
      body: { leadId: data.leadId },
    });
    if (error || !result?.rephrased) {
      throw new Error(
        "Could not safely compose a reply. Your existing draft has not been changed.",
      );
    }
    return result as {
      rephrased: string;
      runId: string;
      model: string;
      version: string;
      warnings: string[];
    };
  });

export const autoRephraseLeadWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ leadId: z.string().min(1) }).parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterCanRephrase(context.userId);

    // Check if auto-rephrase toggle is enabled (default is OFF)
    const { data: toggleState } = await supabaseAdmin
      .from("shared_state")
      .select("value")
      .eq("key", "cs_auto_rephrase_enabled")
      .maybeSingle();

    const isAutoRephraseOn = Boolean(
      toggleState?.value &&
      typeof toggleState.value === "object" &&
      !Array.isArray(toggleState.value) &&
      (toggleState.value as { enabled?: boolean }).enabled,
    );

    if (!isAutoRephraseOn) {
      return { success: false, reason: "Auto-rephrase is disabled (toggle is OFF)" };
    }

    const { data: lead, error } = await context.supabase
      .from("qualified_leads")
      .select(
        "id, updated_at, customer_name, context, post_text, service, requirement_1, requirement_2, marketing_notes",
      )
      .eq("id", data.leadId)
      .maybeSingle();

    if (error || !lead) return { success: false, reason: "Lead not found" };

    // Strict safety check: If marketing_notes is already populated, DO NOT overwrite!
    if (lead.marketing_notes && lead.marketing_notes.trim().length > 0) {
      return { success: false, reason: "Already has marketing_notes" };
    }

    const contextText = lead.context || lead.post_text || "";
    if (!contextText.trim()) {
      return { success: false, reason: "No context text available" };
    }

    try {
      const { data: result, error: composeError } = await context.supabase.functions.invoke(
        "cs-compose-lead",
        {
          body: { leadId: lead.id },
        },
      );
      if (composeError || !result?.rephrased) throw new Error("Could not safely compose a reply");
      const finalSms = result.rephrased as string;

      if (finalSms) {
        // Update database with rephrased SMS
        const { data: saved, error: saveError } = await context.supabase
          .from("qualified_leads")
          .update({ marketing_notes: finalSms } as never)
          .eq("id", lead.id)
          .eq("updated_at", lead.updated_at)
          .select("id");
        if (saveError || !saved?.length)
          return {
            success: false,
            reason: "Lead changed while composing; draft was not overwritten",
          };

        return { success: true, rephrased: finalSms };
      }
    } catch (err) {
      console.error("[Auto-rephrase] Failed for lead:", lead.id, err);
      return { success: false, reason: (err as Error).message };
    }

    return { success: false, reason: "No output generated" };
  });
