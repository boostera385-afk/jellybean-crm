/**
 * Replay the delivered-lead export and count wording the team would not send.
 *
 *   bun run scripts/audit-compose-wording.ts <delivered.csv>
 *
 * Costs nothing and calls no model. Where eval-ask-catalogue.ts asks whether
 * the right KIND of question was chosen, this asks whether its WORDING is the
 * team's, by four checks taken from defects found reading real drafts:
 *
 *   off-script   a question the team never wrote word-for-word - how
 *                "the size of the paint that needs to be painted" was found.
 *                Whole-word matching: a fragment that only occurs inside a
 *                longer word in the corpus does not count as written.
 *   brand        the brand asked although the lead names one
 *   assumed      a job asserted ("needs to be repaired") with no action seen
 *   move         a move asked for one address, when it is not inside one
 *                property (the team asks a move for both ends 66% of the time)
 *
 * "off-script" over-counts on purpose: a fragment can read perfectly well and
 * simply not be verbatim ("the area where the switch needs to be installed").
 * The examples it prints are there to be read, not just counted.
 *
 * Against the 27,552-lead export: 90.2% clean before
 * 2026-10-22.catalogue-v3.3-grounded, 97.6% after.
 */
import { readFileSync } from "node:fs";
import { detect, normalizeSource } from "../supabase/functions/_shared/cs-detect.ts";
import { selectAsks } from "../supabase/functions/_shared/cs-ask-policy.ts";
import { CS_ASK_CATALOGUE } from "../supabase/functions/_shared/cs-ask-catalogue.generated.ts";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun run scripts/audit-compose-wording.ts <delivered.csv>");
  process.exit(2);
}

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

const rows = parseCsv(readFileSync(file, "utf8"));
const corpus = rows.map((row) => normalizeSource(row["Composed Message"] ?? "")).join(" || ");
const written = new Map<string, boolean>();
const teamWrote = (fragment: string) => {
  if (!written.has(fragment)) {
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    written.set(fragment, new RegExp(`(?:^|[^a-z])${escaped}(?![a-z])`).test(corpus));
  }
  return written.get(fragment)!;
};
const brand = new RegExp(CS_ASK_CATALOGUE.factPatterns["BRAND/MODEL"], "i");
const JOB_VERB = /\b(?:repaired|replaced|installed|fixed|removed|cleaned)\b/;

type Check = "offScript" | "brand" | "assumed" | "move";
const checks: Check[] = ["offScript", "brand", "assumed", "move"];
const counts: Record<Check | "any", number> = {
  offScript: 0,
  brand: 0,
  assumed: 0,
  move: 0,
  any: 0,
};
const examples: Record<Check, string[]> = { offScript: [], brand: [], assumed: [], move: [] };
let leads = 0;

for (const row of rows) {
  const parts = [row["Exact Customer Requirement"], row["Context"]].filter(Boolean);
  if (!parts.length) continue;
  const detection = detect(parts);
  const sources = normalizeSource(parts.join("\n"));
  const target = detection.objects[0] ?? null;
  const selection = selectAsks(detection, row["Service"], target, sources);
  if (!selection.asks.length) continue;
  leads++;
  const fragments = selection.asks.map((ask) => ask.fragment);
  const found: Record<Check, boolean> = {
    offScript: fragments.some((fragment) => !teamWrote(normalizeSource(fragment))),
    brand: selection.asks.some((ask) => ask.intent === "BRAND/MODEL") && brand.test(sources),
    assumed: detection.action === null && fragments.some((fragment) => JOB_VERB.test(fragment)),
    move:
      detection.action === "move" &&
      !detection.sameSite &&
      selection.asks.some((ask) => ask.intent === "ADDRESS" && !/pick ?up/i.test(ask.fragment)),
  };
  for (const check of checks) {
    if (!found[check]) continue;
    counts[check]++;
    if (examples[check].length < 5)
      examples[check].push(
        `[${target}|${detection.action}] ${fragments.join("  +  ")}  <<  ${parts[0].slice(0, 60)}`,
      );
  }
  if (checks.some((check) => found[check])) counts.any++;
}

const share = (n: number) =>
  `${String(n).padStart(6)} ${((100 * n) / leads).toFixed(1).padStart(5)}%`;
console.log(`leads replayed: ${leads}\n`);
console.log(`question the team never wrote word-for-word  ${share(counts.offScript)}`);
console.log(`brand asked although the lead names one      ${share(counts.brand)}`);
console.log(`job assumed with no action detected          ${share(counts.assumed)}`);
console.log(`a move asked for one address                 ${share(counts.move)}`);
console.log(`any of the four                              ${share(counts.any)}`);
console.log(`clean on all four: ${(100 - (100 * counts.any) / leads).toFixed(1)}%`);
for (const check of checks) {
  if (!examples[check].length) continue;
  console.log(`\n${check}:`);
  for (const example of examples[check]) console.log(`  ${example}`);
}
