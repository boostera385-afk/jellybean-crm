/**
 * Live smoke test: run REAL leads from production through the same composer
 * pipeline as executeAiRephraseCore (same prompt resolution, few-shots,
 * model, generation controls) and grade the output for noise.
 *
 *   bun run scripts/smoke-compose-live.ts <leads.json>
 *
 * The leads file is an array of
 *   { id, customer_name, context, post_text, service, requirement_1, requirement_2 }
 *
 * OPENAI_API_KEY is required. Cost: one gpt-5.4-mini call per lead with
 * medium reasoning — trivially small volume.
 */
import { readFileSync } from "node:fs";
import {
  INPUT_SEMANTICS_ADDENDUM,
  isCustomRephrasePrompt,
} from "../src/lib/cs-rephrase-prompt.ts";
import {
  canonicalizeRequirement,
  selectComposeExemplars,
} from "../src/lib/compose-style.ts";

const MODEL = "gpt-5.4-mini-2026-03-17";

type Lead = {
  id: string;
  customer_name: string | null;
  context: string | null;
  post_text: string | null;
  service: string | null;
  requirement_1: string | null;
  requirement_2: string | null;
};

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");
const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: bun run scripts/smoke-compose-live.ts <leads.json>");
const leads: Lead[] = JSON.parse(readFileSync(file, "utf8"));

// ---- exact replicas of the server-side pipeline (raw-leads-ai.functions.ts) --

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
  for (const [regex, rep] of replacements) clean = clean.replace(regex, rep);
  return clean.replace(/\s+/g, " ").trim();
};

const normalizeRequirement = (req: string): string =>
  canonicalizeRequirement(sanitizeForbiddenPhrases(req));

const normalizeServiceContext = (ctx: string): string => {
  if (!ctx) return "your service";
  let clean = sanitizeForbiddenPhrases(ctx).replace(/\s+/g, " ").trim();
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

const trimForAi = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length <= 1500 ? trimmed : `${trimmed.slice(0, 1500)}...`;
};

// The deployed server uses the saved prompt when it is a deliberate
// customisation (it currently is: the migrated 3-field prompt).
let savedPrompt = "";
try {
  savedPrompt = JSON.parse(
    process.env.SMOKETEST_SAVED_PROMPT ?? '{"text":""}',
  ).text as string;
} catch {}
const systemPromptBase = isCustomRephrasePrompt(savedPrompt)
  ? savedPrompt.trim()
  : "";
const systemPrompt = `${systemPromptBase}\n\n${INPUT_SEMANTICS_ADDENDUM}`;

async function compose(lead: Lead) {
  const exemplars = selectComposeExemplars(lead.service, 6);
  const fewShot = exemplars.flatMap((ex) => [
    {
      role: "user" as const,
      content: JSON.stringify({ context: ex.context, exact: ex.exact, service: ex.service }),
    },
    { role: "assistant" as const, content: JSON.stringify(ex.out) },
  ]);
  const userContent = JSON.stringify({
    context: lead.context || "",
    exact: trimForAi(lead.post_text || ""),
    service: lead.service || "",
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "medium",
      temperature: 0.2,
      max_tokens: 1200,
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
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `OpenAI failed (${res.status})`);
  const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");

  const sender = "Alex"; // fixed sender for readability in this test
  const first = (lead.customer_name ?? "there").trim().split(/\s+/)[0] || "there";
  const svc = normalizeServiceContext(parsed.serviceContext || "");
  const r1 = normalizeRequirement(parsed.requirement1 || "");
  const r2 = normalizeRequirement(parsed.requirement2 || "");
  const reqs = r1 && r2 ? `${r1} and ${r2}` : r1 || r2 || "confirm the details";
  return `Hi ${first}, this is ${sender}. I saw that you are looking for ${svc}. Could you kindly ${reqs}, so I can check the schedule for a visit?`;
}

// ---- noise grading -----------------------------------------------------------

const norm = (s: string) => (s ?? "").toLowerCase();
type Flag = { label: string; test: (lead: Lead, msg: string) => boolean };

const flags: Flag[] = [
  {
    label: "asks for already-stated issue",
    // Lead whose words state a concrete problem but the message still asks
    // "what issue / what's wrong / what happened".
    test: (lead, msg) =>
      /\b(what issue|what's wrong|whats wrong|what happened|what is the problem)\b/.test(norm(msg)) &&
      /\b(completely stopped|not cooling|stopped working|broken|failed|leak)/.test(
        norm(lead.post_text ?? ""),
      ),
  },
  {
    label: "asks for already-stated brand",
    test: (lead, msg) =>
      /\b(what brand|which brand|brand of the)\b/.test(norm(msg)) &&
      /\b(lg|ge profile|govee|whirlpool|samsung)\b/.test(norm(lead.post_text ?? "")),
  },
  {
    label: "asks for already-stated time",
    test: (lead, msg) =>
      /\b(when are you|what time|your availability)\b/.test(norm(msg)) &&
      /\b(today|tonight|tomorrow|from 1pm|at 9am|asap|the 16th)\b/.test(
        norm(lead.post_text ?? ""),
      ),
  },
  {
    label: "paste label leak",
    test: (_lead, msg) => /customer need|service needed/i.test(norm(msg)),
  },
  {
    label: "placeholder leak",
    test: (_lead, msg) => /\(requirements\)|\{.*\}|\[.*\]/.test(msg),
  },
  {
    label: "duplicate 'looking for'",
    test: (_lead, msg) => /looking for looking for/i.test(norm(msg)),
  },
  {
    label: "redundant service echo",
    test: (lead, msg) => {
      if (!lead.service) return false;
      const words = norm(lead.service).split(/\s+/).filter((w) => w.length > 3);
      const occurrences = words.reduce(
        (n, w) => n + (norm(msg).split(w).length - 1),
        0,
      );
      return occurrences >= words.length * 2 + 1;
    },
  },
  {
    label: "requirement not verb-led",
    test: (_lead, msg) => {
      const m = /Could you kindly (.+), so I can/.exec(msg);
      return !m || !/^(share|let me know|send me|send|tell me|tell|confirm|provide)\b/i.test(m[1]);
    },
  },
  {
    label: "asks to call back",
    test: (_lead, msg) => /\b(call me back|give you a call|phone call)\b/i.test(norm(msg)),
  },
];

let clean = 0;
const report: Array<{ lead: string; msg: string; flags: string[] }> = [];
for (const lead of leads) {
  const msg = await compose(lead);
  const hit = flags.filter((f) => f.test(lead, msg)).map((f) => f.label);
  if (hit.length === 0) clean++;
  report.push({ lead: `${lead.customer_name} (${lead.service})`, msg, flags: hit });
  console.log(`\n[${lead.customer_name} · ${lead.service}]${hit.length ? `  ⚠ ${hit.join(", ")}` : "  ✓ clean"}`);
  console.log(`  ${msg}`);
}
console.log(`\n${clean}/${leads.length} messages noise-free`);
for (const r of report.filter((r) => r.flags.length)) {
  console.log(`FLAG ${r.lead}: ${r.flags.join(", ")}`);
}
