/**
 * Replay the delivered-lead export through the real selection code.
 *
 *   bun run scripts/eval-ask-catalogue.ts <delivered.csv> [rows]
 *
 * Costs nothing and calls no model: question selection is deterministic, so
 * every row can be re-decided offline against what the team actually sent.
 * What it reports per sub-category:
 *
 *   agree      selected the same lead ask the team used
 *   pair       selected the same ordered pair
 *   fixed      the team re-asked something the customer had already supplied
 *              and this selection does not. These are the rows v3 is meant to
 *              improve on, so a high number here is the point, not a failure.
 *   diverged   neither matched nor explained by suppression - the rows worth
 *              reading by hand.
 *
 * Agreement is a regression signal, not a target, and it has a ceiling well
 * below 100%: the team is not self-consistent, so the run prints the best
 * score ANY fixed per-sub-category choice could reach. Scoring at or above
 * that line means the selection is as faithful as a deterministic policy can
 * be; 100% would mean inheriting the habits the hard guards exist to remove.
 *
 * The model's contribution (which item a multi-item post is about) cannot be
 * replayed offline, so this uses the first detected object - the same fallback
 * the Edge Function applies when the model returns an unknown target. Rows
 * naming several objects are reported separately for that reason.
 */
import { readFileSync } from "node:fs";
import { detect, normalizeSource } from "../supabase/functions/_shared/cs-detect.ts";
import { selectAsks } from "../supabase/functions/_shared/cs-ask-policy.ts";
import { CS_ASK_CATALOGUE } from "../supabase/functions/_shared/cs-ask-catalogue.generated.ts";
import type { AskIntent } from "../supabase/functions/_shared/cs-ask-catalogue-types.ts";

const [file, limitArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun run scripts/eval-ask-catalogue.ts <delivered.csv> [rows]");
  process.exit(2);
}
const limit = Number(limitArg) || Infinity;

/** Minimal RFC4180 reader: the export quotes fields and embeds newlines. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body
    .filter((cells) => cells.length >= header.length)
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}

const ASK_BLOCK = /[Cc]ould you kindly\s+([\s\S]*?)(?:,?\s*so (?:I|we) can|\?|$)/;
const ASK_SPLIT = /\s+and\s+(?=share|let me know|send|tell|confirm|provide|your|the)/;

function classify(ask: string): AskIntent | "OTHER" {
  const a = normalizeSource(ask);
  if (/\baddress(?:es)?\b/.test(a)) return "ADDRESS";
  if (/picture|photo|image/.test(a)) return "PHOTO";
  if (/availability|best time|what time|when you would like/.test(a)) return "AVAILABILITY";
  if (/what issue|what problem|issue you are facing|what type of pest/.test(a)) return "PROBLEM";
  if (/\bbrand\b|\bmake\b|model/.test(a)) return "BRAND/MODEL";
  if (/size|dimension|how (?:big|large|tall|long|many square)|ceiling height|length/.test(a))
    return "SIZE";
  if (/how many|quantity|number of/.test(a)) return "QUANTITY";
  if (/already have|do you have|if you own|replacement/.test(a)) return "OWNERSHIP";
  if (/single or double story|how many stor/.test(a)) return "STORIES";
  if (/what exactly needs|what needs to be done|more details/.test(a)) return "SCOPE";
  return "OTHER";
}

/**
 * Agreement has a hard ceiling well under 100%, because the team is not
 * self-consistent: for a roof it led with a photo 26% of the time and with
 * storeys 26% of the time. The best ANY fixed per-sub-category choice can
 * score is the average modal share, which this computes alongside, so the
 * measured number can be read against what was actually achievable.
 */
type Ceiling = { leads: Map<string, Map<string, number>>; pairs: Map<string, Map<string, number>> };
const ceiling: Ceiling = { leads: new Map(), pairs: new Map() };
const bump = (store: Map<string, Map<string, number>>, key: string, value: string) => {
  const inner = store.get(key) ?? new Map<string, number>();
  inner.set(value, (inner.get(value) ?? 0) + 1);
  store.set(key, inner);
};
const modalTotal = (store: Map<string, Map<string, number>>) =>
  [...store.values()].reduce((sum, inner) => sum + Math.max(...inner.values()), 0);

type Bucket = {
  n: number;
  agree: number;
  pair: number;
  attested: number;
  fixed: number;
  diverged: number;
  noAsk: number;
};
const blank = (): Bucket => ({
  n: 0,
  agree: 0,
  pair: 0,
  attested: 0,
  fixed: 0,
  diverged: 0,
  noAsk: 0,
});

/**
 * "Attested" is the question that matters for "according to our data": not
 * whether this is the pair THIS agent chose for THIS lead -- the team itself
 * disagrees about that half the time -- but whether it is a pair the team
 * actually sends for this kind of job. Three separate uses are required, so a
 * combination one agent sent once does not count as the team's own.
 */
const ATTESTED_MIN_USES = 3;
const overall = blank();
const byObject = new Map<string, Bucket>();
const multiObject = blank();
const examples: string[] = [];

const allRows = parseCsv(readFileSync(file, "utf8"));
const actualAsks = (row: Record<string, string>) => {
  const block = ASK_BLOCK.exec(row["Composed Message"] ?? "");
  if (!block) return null;
  const asks = normalizeSource(block[1])
    .split(ASK_SPLIT)
    .map((ask) => ask.trim().replace(/[.,]+$/, ""))
    .filter(Boolean)
    .map(classify);
  return asks.length ? asks : null;
};
const targetOf = (row: Record<string, string>) => {
  const parts = [row["Exact Customer Requirement"], row["Context"]].filter(Boolean);
  return detect(parts).objects[0] ?? null;
};
// First pass: which pairs the team sends for each sub-category.
const teamPairs = new Map<string, Map<string, number>>();
for (const row of allRows) {
  const actual = actualAsks(row);
  if (actual) bump(teamPairs, targetOf(row) ?? "(none)", actual.join("+"));
}
const isAttested = (target: string, pair: string) =>
  (teamPairs.get(target)?.get(pair) ?? 0) >= ATTESTED_MIN_USES;

let scanned = 0;
for (const row of allRows) {
  if (scanned >= limit) break;
  const block = ASK_BLOCK.exec(row["Composed Message"] ?? "");
  if (!block) continue;
  const actual = normalizeSource(block[1])
    .split(ASK_SPLIT)
    .map((ask) => ask.trim().replace(/[.,]+$/, ""))
    .filter(Boolean)
    .map(classify);
  if (!actual.length) continue;
  scanned++;

  const parts = [row["Exact Customer Requirement"], row["Context"]].filter(Boolean);
  const sources = normalizeSource(parts.join("\n"));
  const detection = detect(parts);
  const target = detection.objects[0] ?? null;
  const selection = selectAsks(detection, row["Service"], target, sources);
  const chosen = selection.asks.map((ask) => ask.intent);

  bump(ceiling.leads, target ?? "(none)", actual[0]);
  bump(ceiling.pairs, target ?? "(none)", actual.join("+"));

  const bucket = byObject.get(target ?? "(none)") ?? blank();
  const tally = [overall, bucket, ...(detection.objects.length > 1 ? [multiObject] : [])];
  for (const entry of tally) entry.n++;

  if (!chosen.length) {
    for (const entry of tally) entry.noAsk++;
    continue;
  }
  const sameLead = chosen[0] === actual[0];
  const samePair = chosen.length === actual.length && chosen.every((key, i) => key === actual[i]);
  const attested = isAttested(target ?? "(none)", chosen.join("+"));
  // Did the team ask for something the customer had already supplied?
  const teamRepeated = actual.some(
    (key) => key !== "OTHER" && key !== "SCOPE" && detection.facts[key] === true,
  );
  const weRepeated = chosen.some((key) => detection.facts[key] === true);
  for (const entry of tally) {
    if (sameLead) entry.agree++;
    if (samePair) entry.pair++;
    if (attested) entry.attested++;
    if (teamRepeated && !weRepeated) entry.fixed++;
    if (!sameLead && !(teamRepeated && !weRepeated)) entry.diverged++;
  }
  if (!sameLead && !teamRepeated && examples.length < 12) {
    examples.push(
      `  ${(target ?? "(none)").padEnd(16)} team=${actual.join("+").padEnd(22)} v3=${chosen.join("+")}`,
    );
  }
  byObject.set(target ?? "(none)", bucket);
}

const pct = (part: number, whole: number) =>
  whole ? `${((100 * part) / whole).toFixed(1)}%` : "-";
const line = (label: string, b: Bucket) =>
  `${label.padEnd(18)} ${String(b.n).padStart(6)} ${pct(b.agree, b.n).padStart(7)} ${pct(
    b.pair,
    b.n,
  ).padStart(7)} ${pct(b.attested, b.n).padStart(9)} ${pct(b.fixed, b.n).padStart(7)} ${pct(
    b.diverged,
    b.n,
  ).padStart(9)} ${pct(b.noAsk, b.n).padStart(7)}`;

console.log(`catalogue: ${CS_ASK_CATALOGUE.meta.rows} rows, replayed ${scanned}\n`);
console.log(
  `${"".padEnd(18)} ${"n".padStart(6)} ${"lead".padStart(7)} ${"pair".padStart(7)} ${"attested".padStart(9)} ${"fixed".padStart(7)} ${"diverged".padStart(9)} ${"no ask".padStart(7)}`,
);
console.log(line("OVERALL", overall));
console.log(
  line("CEILING (modal)", {
    n: scanned,
    agree: modalTotal(ceiling.leads),
    pair: modalTotal(ceiling.pairs),
    // Every modal pair is by definition one the team sends.
    attested: scanned,
    fixed: 0,
    diverged: 0,
    noAsk: 0,
  }),
);
console.log(line("multi-object rows", multiObject));
console.log("\nby sub-category (>=50 rows, weakest lead agreement first):");
for (const [name, bucket] of [...byObject.entries()]
  .filter(([, b]) => b.n >= 50)
  .sort((a, b) => a[1].agree / a[1].n - b[1].agree / b[1].n)) {
  console.log(line(name, bucket));
}
if (examples.length) {
  console.log("\ndiverged without a suppression reason - read these by hand:");
  console.log(examples.join("\n"));
}
