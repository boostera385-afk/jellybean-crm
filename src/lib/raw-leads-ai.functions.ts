import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivity } from "@/lib/activity-log";
import { DEFAULT_CS_COMPOSE_TEMPLATE } from "@/lib/cs-compose-template";
import { INPUT_SEMANTICS_ADDENDUM, isCustomRephrasePrompt } from "@/lib/cs-rephrase-prompt";

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

/**
 * The rephrase/compose model, pinned so prompt tuning is reproducible.
 *
 * gpt-4o-mini — the previous composer — hallucinated generic questions
 * ("let me know what issue you are facing") even when the customer's own
 * words, sent as `exact`, already stated the issue. gpt-5.4-mini handles
 * "what is genuinely missing" reasoning far better at a negligible cost
 * difference for CS-pipeline volume. Override with OPENAI_COMPOSE_MODEL.
 *
 * Deliberately NOT falling back to OPENAI_MODEL: a stray OPENAI_MODEL value
 * in the environment (an old deploy had it set to gpt-4o-mini) would silently
 * undo this upgrade. The override must be explicit COMPOSE-specific.
 */
const COMPOSE_MODEL_DEFAULT = "gpt-5.4-mini-2026-03-17";
const COMPOSE_TEMPERATURE = 0.2;
// Reasoning tokens count against this budget; medium reasoning on the mini
// model needs headroom beyond the small JSON answer itself.
const COMPOSE_MAX_TOKENS = 1200;
const COMPOSE_REASONING_EFFORT = "medium";
const COMPOSE_TIMEOUT_MS = 20_000;

function composeModel(): string {
  return process.env.OPENAI_COMPOSE_MODEL?.trim() || COMPOSE_MODEL_DEFAULT;
}

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
  template: z.string(),
  customerName: z.string(),
  contextText: z.string().nullable().optional(),
  exactRequirement: z.string().nullable().optional(),
  service: z.string().nullable().optional(),
  requirement1: z.string().nullable().optional(),
  requirement2: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
});

/**
 * Resolve the system prompt for one rephrase call.
 *
 * Priority: caller-supplied override → saved `cs_rephrase_prompt` (when it is
 * a deliberate customisation, not a stale copy of the retired default) → the
 * trained compose prompt. Reading the saved prompt here means every path —
 * single lead, bulk, auto — honours the same override; previously only bulk
 * did, so the prompt editor looked broken for half the pipeline.
 */
async function resolveComposeSystemPrompt(customSystemPrompt?: string | null): Promise<string> {
  let prompt = (customSystemPrompt ?? "").trim();
  if (!prompt) {
    try {
      const { data } = await supabaseAdmin
        .from("shared_state")
        .select("value")
        .eq("key", "cs_rephrase_prompt")
        .maybeSingle();
      const stored = (data?.value as { text?: string } | null)?.text ?? "";
      if (isCustomRephrasePrompt(stored)) prompt = stored.trim();
    } catch {
      // The saved prompt is a convenience, never a hard dependency.
    }
  }
  // Input semantics describe how to READ the lead, not how to write the
  // output, so they ride along on every call — even with a saved custom
  // prompt, which an admin may replace without re-saving these rules.
  const { buildComposeSystemPrompt } = await import("@/lib/compose-style");
  return `${prompt || buildComposeSystemPrompt()}\n\n${INPUT_SEMANTICS_ADDENDUM}`;
}

// One retry covers transient 429/5xx failures; validation errors are never retried.
function isRetryableComposeStatus(status: number) {
  return status === 429 || status >= 500;
}

/**
 * One OpenAI chat completion for a compose rephrase.
 *
 * gpt-4o-mini ran with no temperature, no token cap, no timeout and no retry:
 * the randomness was a direct source of the question noise. Generation
 * controls keep the output low-variance, the abort signal stops the caller
 * hanging on a wedged request, and one backoff retry absorbs transient
 * failures. If the pinned model rejects an optional generation control, the
 * fallback attempt drops the controls so a real answer still comes back.
 */
async function callComposeOpenAi({
  model,
  systemPrompt,
  fewShot,
  userContent,
}: {
  model: string;
  systemPrompt: string;
  fewShot: Array<{ role: "user" | "assistant"; content: string }>;
  userContent: string;
}): Promise<{ ok: boolean; status: number; body: OpenAiResponse }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY secret");

  const request = {
    model,
    // Explicit reasoning measurably sharpens "what is genuinely missing?"
    // without changing the few-shot format (carried over from the team's nano
    // experiment; the mini model keeps it as well).
    reasoning_effort: COMPOSE_REASONING_EFFORT,
    messages: [
      { role: "system", content: systemPrompt },
      ...fewShot,
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "lead_rephrase",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            serviceContext: { type: "string" },
            requirement1: { type: "string" },
            requirement2: { type: "string" },
          },
          required: ["serviceContext", "requirement1", "requirement2"],
        },
      },
    },
  } satisfies {
    model: string;
    reasoning_effort: string;
    messages: Array<{ role: string; content: string }>;
    response_format: {
      type: "json_schema";
      json_schema: {
        name: string;
        strict: boolean;
        schema: Record<string, unknown>;
      };
    };
  };
  const controls = { temperature: COMPOSE_TEMPERATURE, max_tokens: COMPOSE_MAX_TOKENS };

  for (let attempt = 0; attempt < 2; attempt++) {
    const withControls = attempt === 0;
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(withControls ? { ...request, ...controls } : request),
        // Browsers do not support AbortSignal.timeout, but this runs server side only.
        signal: AbortSignal.timeout(COMPOSE_TIMEOUT_MS),
      });
      const body = (await response.json()) as OpenAiResponse;
      if (response.ok) return { ok: true, status: response.status, body };
      const message = body.error?.message ?? "";
      if (
        withControls &&
        /temperature|max[_ -]?tokens|unsupported|unknown parameter/i.test(message)
      ) {
        continue; // Model rejected an optional control — retry once without them.
      }
      if (!withControls || !isRetryableComposeStatus(response.status)) {
        return { ok: false, status: response.status, body }; // Caller converts it to a thrown Error, as before.
      }
    } catch (err) {
      if (attempt === 0) continue; // Network error or timeout: retry once.
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("OpenAI compose call did not return a response"); // Unreachable safeguard.
}

export async function executeAiRephraseCore({
  customerName,
  contextText,
  exactRequirement,
  service,
  requirement1,
  requirement2,
  systemPrompt: customSystemPrompt,
}: {
  /** Still accepted from callers, but no longer decides the sender name. */
  template?: string;
  customerName: string;
  contextText?: string | null;
  exactRequirement?: string | null;
  service?: string | null;
  requirement1?: string | null;
  requirement2?: string | null;
  systemPrompt?: string | null;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY secret");

  // Imported here rather than at module scope: app.cs-leads.tsx imports this
  // file, and compose-style carries the generated style data (~320KB). A static
  // import would ship all of it to the browser for no reason.
  const { canonicalizeRequirement, selectComposeExemplars } = await import("@/lib/compose-style");
  const { senderForTick, fallbackTick } = await import("@/lib/compose-senders");

  // The roster advances every LEADS_PER_SENDER messages. The counter lives in
  // the database because the run of ten has to hold across requests, server
  // instances and redeploys. If it cannot be read, fall back to a time window
  // so the name still varies rather than pinning every message to one again.
  let senderTick = fallbackTick();
  try {
    const { data: tick, error: tickError } = await supabaseAdmin.rpc("cs_next_compose_sender_tick");
    if (!tickError && tick !== null && tick !== undefined) senderTick = Number(tick);
  } catch {
    // Keep the time-based fallback.
  }

  // The system prompt and examples come from the delivered messages
  // (src/lib/compose-style.ts, scripts/build-compose-style.py). A prompt
  // saved in the UI overrides it, resolved here for every call path.

  // The live input must have the same shape as the exemplar inputs below, or
  // the examples teach the model to read a different payload. `exact` carries
  // the customer's own words; the exemplars cannot show a real customer voice,
  // so the reading rules live in INPUT_SEMANTICS_ADDENDUM on the system prompt
  // instead. They are still used as the fallback if the model reply fails to parse.
  const exemplars = selectComposeExemplars(service, 6);
  const fewShot = exemplars.flatMap((ex) => [
    {
      role: "user" as const,
      content: JSON.stringify({ context: ex.context, exact: ex.exact, service: ex.service }),
    },
    { role: "assistant" as const, content: JSON.stringify(ex.out) },
  ]);

  const userContent = JSON.stringify({
    context: contextText || "",
    exact: trimForAi(exactRequirement || ""),
    service: service || "",
  });

  const response = await callComposeOpenAi({
    model: composeModel(),
    systemPrompt: await resolveComposeSystemPrompt(customSystemPrompt),
    fewShot,
    userContent,
  });

  if (!response.ok) {
    throw new Error(response.body.error?.message ?? `OpenAI request failed (${response.status})`);
  }

  const rephrased = response.body.choices?.[0]?.message?.content || "";

  // Parse the JSON output from AI
  let serviceContext = "";
  let req1 = "";
  let req2 = "";

  try {
    const parsed = JSON.parse(rephrased.trim());
    serviceContext = parsed.serviceContext || "";
    req1 = parsed.requirement1 || "";
    req2 = parsed.requirement2 || "";
  } catch {
    // Fallback in case JSON parsing fails
    serviceContext = contextText || "";
    req1 = requirement1 || "";
    req2 = requirement2 || "";
  }

  // Helper functions for sanitization & normalization
  const extractFirstName = (fullName: string): string => {
    const name = fullName.trim().split(/\s+/)[0];
    return name || "there";
  };

  const sanitizeForbiddenPhrases = (text: string): string => {
    if (!text) return "";
    let clean = text;
    const replacements: Array<[RegExp, string]> = [
      [/I understand/gi, ""],
      [/seeking/gi, "looking for"],
      [/repair or replacement/gi, "repair"],
      [/damaged or non-functioning/gi, ""],
      [/provide the service address/gi, "share your complete address"],
      [/our schedule/gi, "the schedule"],
      [/arrange a visit/gi, "check the schedule for a visit"],
    ];
    for (const [regex, rep] of replacements) {
      clean = clean.replace(regex, rep);
    }
    return clean.replace(/\s+/g, " ").trim();
  };

  // Snap the ask onto the team's majority wording (see compose-style.ts).
  // The previous hardcoded rules rewrote every picture request to
  // "send me a picture of it" - wording that appears nowhere in the delivered
  // messages, where the object is always named - and sent any requirement
  // merely containing "when" or "time" to availability.
  const normalizeRequirement = (req: string): string =>
    canonicalizeRequirement(sanitizeForbiddenPhrases(req));

  const normalizeServiceContext = (ctx: string): string => {
    if (!ctx) return "your service";
    // Keep the word "service" AND the customer's specifics. The delivered style
    // is "a garage door repair service to repair an off track roll up garage
    // door", not a bare "garage door repair"; the old version stripped
    // /\bservice\b/ and dropped any " for ..." clause that shared a word with
    // the head, which left sentences like "looking for a window replacement  ."
    let clean = sanitizeForbiddenPhrases(ctx).replace(/\s+/g, " ").trim();
    // Ingestion sometimes prefixes the context with paste labels, and several
    // delivered messages opened with the template words duplicated:
    // "looking for looking for someone to repair ...". Strip the labels and
    // the leading verb so the fixed sentence around serviceContext completes
    // them naturally.
    clean = clean
      .replace(/\b(?:customer\s+needs?|service\s+needed?)\s*:\s*/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:customer\s+needs?|customer\s+request(?:ed)?|need|needs)\s*:?\s*/i, "")
      .replace(/^(?:i\s+am\s+|i'?m\s+)?looking\s+for\s+/i, "")
      .trim();
    clean = clean.replace(/[.?,;!]$/, "");
    if (clean.length > 0) clean = clean.charAt(0).toLowerCase() + clean.slice(1);
    return clean || "your service";
  };

  // Apply sanitization and normalization
  const finalFirstName = extractFirstName(customerName);
  const finalSenderName = senderForTick(senderTick);
  const finalServiceContext = normalizeServiceContext(serviceContext);
  const finalReq1 = normalizeRequirement(req1);
  const finalReq2 = normalizeRequirement(req2);

  // Build requirements part: join with " and " if both are present
  let requirementsPart = "";
  if (finalReq1 && finalReq2) {
    requirementsPart = `${finalReq1} and ${finalReq2}`;
  } else if (finalReq1) {
    requirementsPart = finalReq1;
  } else if (finalReq2) {
    requirementsPart = finalReq2;
  } else {
    requirementsPart = "confirm the details";
  }

  // Build the final strict SMS format
  const finalSms = `Hi ${finalFirstName}, this is ${finalSenderName}. I saw that you are looking for ${finalServiceContext}. Could you kindly ${requirementsPart}, so I can check the schedule for a visit?`;

  return finalSms;
}

export const rephraseLeadTemplateWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => rephraseInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterCanRephrase(context.userId);
    const finalSms = await executeAiRephraseCore({
      template: data.template,
      customerName: data.customerName,
      contextText: data.contextText,
      exactRequirement: data.exactRequirement,
      service: data.service,
      requirement1: data.requirement1,
      requirement2: data.requirement2,
      systemPrompt: data.systemPrompt,
    });
    return { rephrased: finalSms };
  });

export const autoRephraseLeadWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ leadId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, reason: "Missing OPENAI_API_KEY" };

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

    const { data: lead, error } = await supabaseAdmin
      .from("qualified_leads")
      .select(
        "id, customer_name, context, post_text, service, requirement_1, requirement_2, marketing_notes",
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
      const finalSms = await executeAiRephraseCore({
        template: DEFAULT_CS_COMPOSE_TEMPLATE,
        customerName: lead.customer_name || "there",
        contextText: lead.context,
        // The single and bulk rephrase paths already sent the customer's own
        // words and the service label; the auto path silently omitted both,
        // which pushed every auto-composed message toward generic questions.
        exactRequirement: lead.post_text,
        service: lead.service,
        requirement1: lead.requirement_1 || "",
        requirement2: lead.requirement_2 || "",
      });

      if (finalSms) {
        // Update database with rephrased SMS
        await supabaseAdmin
          .from("qualified_leads")
          .update({ marketing_notes: finalSms } as never)
          .eq("id", lead.id);

        return { success: true, rephrased: finalSms };
      }
    } catch (err) {
      console.error("[Auto-rephrase] Failed for lead:", lead.id, err);
      return { success: false, reason: (err as Error).message };
    }

    return { success: false, reason: "No output generated" };
  });
