/**
 * Deterministic reading of a lead: which objects the post is about, which
 * action is wanted, and which facts the customer has already supplied.
 *
 * Every pattern here comes from the generated catalogue, which is produced by
 * scripts/build-ask-catalogue.py from the delivered-lead export. The script is
 * the single source of truth; nothing in this file hard-codes a pattern, so the
 * runtime cannot drift away from the data the ask policy was measured on.
 *
 * No database, env or SDK imports - shared by the app, the Edge Function and
 * the tests.
 */
import { CS_ASK_CATALOGUE } from "./cs-ask-catalogue.generated.ts";
import type { AskIntent } from "./cs-ask-catalogue-types.ts";

const compile = (source: string, flags = "i") => new RegExp(source, flags);

const OBJECT_MATCHERS = CS_ASK_CATALOGUE.objectPatterns.map(([name, source]) => ({
  name,
  test: compile(source),
  strip: compile(source, "gi"),
}));
const ACTION_MATCHERS = CS_ASK_CATALOGUE.actionPatterns.map(([name, source]) => ({
  name,
  test: compile(source),
}));
const FACT_MATCHERS = Object.entries(CS_ASK_CATALOGUE.factPatterns).map(([name, source]) => ({
  name,
  test: compile(source),
  all: compile(source, "gi"),
}));
const PHOTO_NEGATION = compile(CS_ASK_CATALOGUE.photoNegation);

/** Moving within one property, or loading into the customer's own van, is not
 *  a pickup-and-delivery route and must never produce a drop-off question. */
const SAME_SITE =
  /\b(?:backyard|back yard|same (?:property|house|building|address)|within (?:my|the) (?:house|home|property)|into (?:a|my|the|his|her|their) (?:moving )?van|\d+ feet)\b/i;

export type Detection = {
  /** Objects in taxonomy order; the first is the primary unless the model
   *  retargets it. Spans are masked as they match, so "garage door" never
   *  also reports "door". */
  objects: string[];
  action: string | null;
  /** Facts the customer has already supplied, keyed as in the catalogue. */
  facts: Record<string, boolean>;
  sameSite: boolean;
};

export function normalizeSource(value: string): string {
  return value.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when a brand name sits directly against this object, so an LG fridge
 *  in a post about a fridge AND a stove never marks the stove's brand known.
 *
 *  Matched against the object's whole pattern, not its customer-facing label:
 *  "Whirlpool freezer" has to count as a known refrigerator brand even though
 *  the label the team writes is "refrigerator". */
export function brandKnownFor(object: string | null, sources: string): boolean {
  if (!object) return false;
  const pattern = CS_ASK_CATALOGUE.objectPatterns.find(([name]) => name === object)?.[1];
  if (!pattern) return false;
  const brands = CS_ASK_CATALOGUE.factPatterns["BRAND/MODEL"];
  // Up to three words may sit between the brand and the object ("LG French
  // door refrigerator"), but never a conjunction, which would mean the brand
  // belongs to the other appliance in the list.
  return new RegExp(
    `(?:${brands})\\s+(?:(?!and\\b|or\\b)[a-z0-9-]+\\s+){0,3}(?:${pattern})`,
    "i",
  ).test(sources);
}

export function detect(sources: string[]): Detection {
  const text = normalizeSource(sources.filter(Boolean).join("\n"));
  let masked = text;
  const objects: string[] = [];
  for (const matcher of OBJECT_MATCHERS) {
    if (matcher.test.test(masked)) {
      objects.push(matcher.name);
      masked = masked.replace(matcher.strip, " \u0000 ");
    }
  }
  // Actions are read from the masked text so an appliance can't supply its own
  // verb: "washing machine" must not read as a cleaning job. Some objects are
  // themselves verb-derived though - furniture_move matches "move" - so when
  // masking has swallowed the only verb, retry on the original text. `clean` is
  // excluded from that retry because it is the one action a known object name
  // ("washing machine") can still spell out.
  const action =
    ACTION_MATCHERS.find((matcher) => matcher.test.test(masked))?.name ??
    ACTION_MATCHERS.find((matcher) => matcher.name !== "clean" && matcher.test.test(text))?.name ??
    null;
  const facts: Record<string, boolean> = {};
  for (const matcher of FACT_MATCHERS) {
    if (matcher.name === "PHOTO") {
      facts[matcher.name] = [...text.matchAll(matcher.all)].some((match) => {
        const start = match.index ?? 0;
        // "no photos attached" and "I have not sent pictures" are not photos.
        return !PHOTO_NEGATION.test(text.slice(Math.max(0, start - 45), start));
      });
    } else {
      facts[matcher.name] = matcher.test.test(text);
    }
  }
  return { objects, action, facts, sameSite: SAME_SITE.test(text) };
}

/** Facts the delivered data does NOT suppress (measured ~1.0x or inverted), so
 *  the runtime has to suppress them in code rather than inherit the habit. */
export const HARD_GUARDS = new Set<AskIntent>(CS_ASK_CATALOGUE.meta.hardGuards);

/**
 * Whether an ask is already answered and must be dropped.
 *
 * The rule is the same for every intent - a supplied fact is never re-asked -
 * regardless of what the delivered data did. HARD_GUARDS records which facts
 * the data would NOT have suppressed, so a test can assert the override is
 * deliberate rather than accidental.
 */
export function isAnswered(
  intent: AskIntent,
  detection: Detection,
  targetObject: string | null,
  sources: string,
): boolean {
  if (intent === "SCOPE") return false;
  if (intent === "BRAND/MODEL") return brandKnownFor(targetObject, sources);
  return detection.facts[intent] === true;
}
