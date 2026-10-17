/**
 * HISTORICAL STYLE BENCHMARK ONLY (v1). This does NOT evaluate today's CS
 * answer-aware composer or determine whether a question is sensible. Use
 * scripts/smoke-compose-live.ts for the exact production generation pipeline.
 * Score the historical delivered-style prompt against the hand-written one.
 *
 * Both are run over held-out delivered leads that scripts/build-compose-style.py
 * excluded from the exemplar bank and the canonical rules, so the examples
 * cannot leak into the result. Set OPENAI_EVAL_MODEL to compare other models
 * (default: the pinned compose model).
 *
 *   OPENAI_API_KEY=sk-... bun run scripts/eval-compose.ts <holdout.jsonl> [rows]
 *
 * Each row costs two calls of the eval model, so start small (50) to sanity
 * check the spend before running a few hundred.
 */
import { readFileSync } from "node:fs";
import {
  buildComposeSystemPrompt,
  requirementIntentKey,
  selectComposeExemplars,
} from "../src/lib/compose-style.ts";

// Keep in step with COMPOSE_MODEL_DEFAULT in src/lib/raw-leads-ai.functions.ts.
const EVAL_MODEL = process.env.OPENAI_EVAL_MODEL?.trim() || "gpt-5.4-mini-2026-03-17";

const LEGACY_PROMPT = `You are an expert customer service assistant. Your goal is to clean, extract, and normalize three parts of a customer lead request to prepare them for an outbound message.

You must output a JSON object containing exactly three fields:
1. "serviceContext": A very short, clean name of the service (e.g. "garage door repair", "lawn care", "plumbing leak"). It must be concise and lowercase. Never use "service", "seeking", "repair or replacement", or "damaged or non-functioning".
2. "requirement1": The first requirement or question normalized as an action-oriented phrase starting with a lowercase verb.
3. "requirement2": The second requirement or question normalized as an action-oriented phrase starting with a lowercase verb.

Normalization Rules for Requirements (both requirement1 and requirement2):
- If the requirement refers to address, location, or where to go, normalize it to: "share your complete address"
- If the requirement refers to availability, time, or when they are available, normalize it to: "let me know your availability"
- If the requirement refers to a photo, picture, image, or snapshot, normalize it to: "send me a picture of it"
- Otherwise, rephrase to start with a verb (e.g. "confirm whether you have the spring on hand").
- Requirement text must not be capitalized or end with punctuation.`;

const SCHEMA = {
  type: "json_schema" as const,
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
};

type Row = {
  context: string;
  exact: string;
  service: string;
  expected: { serviceContext: string; requirement1: string; requirement2: string };
};
type Slots = { serviceContext: string; requirement1: string; requirement2: string };

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");
const [file, nArg] = process.argv.slice(2);
if (!file) throw new Error("usage: bun run scripts/eval-compose.ts <holdout.jsonl> [rows]");

const rows: Row[] = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row)
  .slice(0, Number(nArg ?? 100));

async function ask(messages: { role: string; content: string }[]): Promise<Slots | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EVAL_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 500,
      response_format: SCHEMA,
    }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  try {
    return JSON.parse(body.choices?.[0]?.message?.content ?? "");
  } catch {
    return null;
  }
}

const norm = (s: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const tokens = (s: string) =>
  new Set(
    norm(s)
      .split(" ")
      .filter((t) => t.length > 2),
  );
function f1(a: string, b: string) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  const hit = [...x].filter((t) => y.has(t)).length;
  return (2 * hit) / (x.size + y.size);
}

type Score = {
  n: number;
  svcF1: number;
  svcHasService: number;
  reqExact: number;
  reqIntent: number;
};
const blank = (): Score => ({ n: 0, svcF1: 0, svcHasService: 0, reqExact: 0, reqIntent: 0 });

function score(acc: Score, got: Slots, want: Slots) {
  acc.n++;
  acc.svcF1 += f1(got.serviceContext, want.serviceContext);
  if (/\bservices?\b/.test(norm(got.serviceContext))) acc.svcHasService++;
  for (const k of ["requirement1", "requirement2"] as const) {
    if (!want[k]) continue;
    if (norm(got[k]) === norm(want[k])) acc.reqExact++;
    if (requirementIntentKey(got[k]) === requirementIntentKey(want[k])) acc.reqIntent++;
  }
}

const legacy = blank();
const trained = blank();
let reqSlots = 0;
let failed = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const input = JSON.stringify({ context: r.context, exact: r.exact, service: r.service });
  reqSlots += [r.expected.requirement1, r.expected.requirement2].filter(Boolean).length;

  const fewShot = selectComposeExemplars(r.service, 6).flatMap((ex) => [
    {
      role: "user",
      content: JSON.stringify({ context: ex.context, exact: ex.exact, service: ex.service }),
    },
    { role: "assistant", content: JSON.stringify(ex.out) },
  ]);

  const [a, b] = await Promise.all([
    ask([
      { role: "system", content: LEGACY_PROMPT },
      {
        role: "user",
        content: JSON.stringify({ context: r.context, requirement1: "", requirement2: "" }),
      },
    ]),
    ask([
      { role: "system", content: buildComposeSystemPrompt() },
      ...fewShot,
      { role: "user", content: input },
    ]),
  ]);
  if (a) score(legacy, a, r.expected);
  if (b) score(trained, b, r.expected);
  if (!a || !b) failed++;
  if ((i + 1) % 25 === 0) console.log(`  ...${i + 1}/${rows.length}`);
}

function report(name: string, s: Score) {
  console.log(
    `${name.padEnd(9)} service phrase F1 ${(s.svcF1 / Math.max(s.n, 1)).toFixed(3)}` +
      `  keeps "service" ${((100 * s.svcHasService) / Math.max(s.n, 1)).toFixed(0)}%` +
      `  requirement exact ${((100 * s.reqExact) / Math.max(reqSlots, 1)).toFixed(1)}%` +
      `  same intent ${((100 * s.reqIntent) / Math.max(reqSlots, 1)).toFixed(1)}%`,
  );
}
console.log(`\nrows=${rows.length} requirement slots=${reqSlots} api failures=${failed}\n`);
report("legacy", legacy);
report("trained", trained);
