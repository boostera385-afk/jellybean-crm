/**
 * Choosing the asks, in the team's own wording.
 *
 * The delivered-lead export settles three things the model used to guess at:
 *
 *   which asks   Each sub-category has a ladder measured from how often the
 *                team asked for a detail when it was MISSING. A refrigerator
 *                repair leads with brand/model; a gutter job leads with
 *                storeys; a carpet clean leads with photos and size.
 *
 *   which order  The team's pair grammar is rigid - address and availability
 *                only ever close a message, intents never repeat - so slots
 *                are filled from pairs that actually occur rather than by
 *                picking two asks independently.
 *
 *   which words  The phrase for an ask depends on the object: "the length of
 *                the fence", "how big the unit is", "the ceiling height". The
 *                model never writes an ask; it only picks one.
 *
 * Suppression is NOT learned. A fact the customer supplied is never re-asked,
 * even where the delivered data would have asked again (availability,
 * ownership, supplied photos and storeys all show no suppression at all).
 *
 * No database, env or SDK imports.
 */
import { CS_ASK_CATALOGUE } from "./cs-ask-catalogue.generated.ts";
import type { AskIntent, Ladder, LadderEntry } from "./cs-ask-catalogue-types.ts";
import { isAnswered, type Detection } from "./cs-detect.ts";

export type SelectedAsk = {
  intent: AskIntent;
  /** Object the ask is aimed at, or null when the phrase is object-free. */
  object: string | null;
  /** The ask as it will appear in the message, e.g. "share a picture of the deck". */
  fragment: string;
};

export type AskSelection = {
  asks: SelectedAsk[];
  /** Which catalogue key supplied the ladder, for auditing and eval scoring. */
  ladderKey: string;
  /** Candidate intents dropped because the customer had already answered. */
  suppressed: AskIntent[];
};

export function serviceKey(service: string | null | undefined): string {
  return (service ?? "")
    .toLowerCase()
    .replace(/\b(?:general|service|services|repair service)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** On a move or a clearance the JOB is the move, and the item is only what is
 *  being moved: a hot tub going 50 feet to the backyard needs the moving
 *  ladder, not the hot-tub-repair ladder that would ask what is wrong with it. */
const JOB_TYPE_LADDERS: Record<string, string[]> = {
  move: ["furniture_move", "junk"],
  remove: ["junk", "furniture_move"],
};

/**
 * Most specific ladder available, falling back one level at a time:
 * (object, action) -> job type -> object -> service -> no-object profile -> all.
 *
 * The no-object profile is a real bucket, not the global average: on posts with
 * no identifiable object the team asks scope and address, which the all-rows
 * average washes out.
 */
export function resolveLadder(
  targetObject: string | null,
  action: string | null,
  service: string | null | undefined,
  objects: string[] = [],
): { key: string; ladder: Ladder } {
  const candidates: string[] = [];
  if (targetObject && action) candidates.push(`${targetObject}|${action}`);
  for (const jobObject of JOB_TYPE_LADDERS[action ?? ""] ?? []) {
    if (!objects.includes(jobObject) || jobObject === targetObject) continue;
    candidates.push(`${jobObject}|${action}`, jobObject);
  }
  if (targetObject) candidates.push(targetObject);
  const key = serviceKey(service);
  if (key) candidates.push(`svc:${key}`);
  candidates.push(targetObject ? "*" : "none", "*");
  for (const candidate of candidates) {
    const ladder = CS_ASK_CATALOGUE.ladders[candidate];
    if (ladder) return { key: candidate, ladder };
  }
  return { key: "none", ladder: { n: 0, entries: [] } };
}

/** Asks that make no sense without naming the thing. "Let me know if you
 *  already have the replacement" - the replacement of what? "Let me know the
 *  size" - of what? These are only ever sent with object-specific wording, of
 *  which the catalogue has a measured form for 29 objects. */
const OBJECT_BOUND_INTENTS = new Set<AskIntent>(["OWNERSHIP", "QUANTITY", "SIZE"]);

/** The team's phrase for this ask, with the object slotted in. Object-specific
 *  wording wins; a generic phrase is used only when one was measured. */
export function wordingFor(intent: AskIntent, object: string | null): string | null {
  const specific = object ? CS_ASK_CATALOGUE.wording[`${intent}|${object}`] : undefined;
  if (!specific && OBJECT_BOUND_INTENTS.has(intent)) return null;
  const entry = specific ?? CS_ASK_CATALOGUE.genericWording[intent];
  if (!entry) return null;
  const [singular, plural] = CS_ASK_CATALOGUE.objectLabels[object ?? ""] ?? ["", ""];
  const phrase = entry.phrase
    .replace(/\{objects\}/g, plural)
    .replace(/\{object\}/g, singular)
    .replace(/\s+/g, " ")
    .trim();
  // An unfilled slot would reach a customer as "{object}". Drop the ask rather
  // than send a placeholder; the next candidate takes the slot.
  return phrase.includes("{") || !phrase ? null : phrase;
}

type Candidate = { entry: LadderEntry; fragment: string; object: string | null };

function candidatesFor(
  ladder: Ladder,
  detection: Detection,
  targetObject: string | null,
  sources: string,
): { candidates: Candidate[]; suppressed: AskIntent[] } {
  const candidates: Candidate[] = [];
  const suppressed: AskIntent[] = [];
  for (const entry of ladder.entries) {
    if (isAnswered(entry.intent, detection, targetObject, sources)) {
      suppressed.push(entry.intent);
      continue;
    }
    const object = CS_ASK_CATALOGUE.wording[`${entry.intent}|${targetObject}`]
      ? targetObject
      : null;
    let fragment = wordingFor(entry.intent, object);
    // Moving inside one property is not a route: fall back to the plain
    // address ask rather than requesting a drop-off the job does not have.
    if (
      fragment &&
      entry.intent === "ADDRESS" &&
      detection.sameSite &&
      /pick.?up/i.test(fragment)
    ) {
      fragment = wordingFor("ADDRESS", null);
    }
    if (fragment) candidates.push({ entry, fragment, object });
  }
  return { candidates, suppressed };
}

/**
 * Fill at most two slots.
 *
 * Both slots are chosen together, from the ordered pairs the team actually
 * sent for this sub-category - its own joint distribution, not the product of
 * two marginal rates. That distinction is load-bearing: a window clean asks
 * size before photos even though photos are its more frequent single ask, and
 * only the joint counts show it. The first pair whose asks both survive
 * suppression wins, so the result is "what this team asks for this kind of
 * job, minus whatever the customer already told us".
 *
 * When no measured pair survives, one ask is sent, weighted by how often that
 * intent stood alone: a photo or an address is normal on its own, a storey
 * count is not.
 */
export function selectAsks(
  detection: Detection,
  service: string | null | undefined,
  targetObject: string | null,
  sources: string,
): AskSelection {
  const { key, ladder } = resolveLadder(targetObject, detection.action, service, detection.objects);
  const { candidates, suppressed } = candidatesFor(ladder, detection, targetObject, sources);
  const ranked = [...candidates].sort((a, b) => b.entry.askIfMissing - a.entry.askIfMissing);
  const take = (candidate: Candidate): SelectedAsk => ({
    intent: candidate.entry.intent,
    object: candidate.object,
    fragment: candidate.fragment,
  });
  const byIntent = new Map(candidates.map((candidate) => [candidate.entry.intent, candidate]));

  // The sub-category's own pair distribution first, then the global one. Both
  // are ordered most-used first, so the first pair whose asks both survive
  // suppression is the one the team sends most often in this situation.
  for (const pairs of [CS_ASK_CATALOGUE.pairsByKey[key] ?? [], CS_ASK_CATALOGUE.pairs]) {
    for (const pair of pairs) {
      const lead = byIntent.get(pair.slot1);
      const closer = byIntent.get(pair.slot2);
      if (!lead || !closer) continue;
      return {
        asks: [take(lead), take(closer)],
        ladderKey: key,
        suppressed: [...new Set(suppressed)],
      };
    }
  }
  let solo: { score: number; candidate: Candidate } | null = null;
  for (const candidate of ranked) {
    const share = CS_ASK_CATALOGUE.solo[candidate.entry.intent] ?? 0.01;
    const score = share * candidate.entry.askIfMissing;
    if (!solo || score > solo.score) solo = { score, candidate };
  }
  return {
    asks: solo ? [take(solo.candidate)] : [],
    ladderKey: key,
    suppressed: [...new Set(suppressed)],
  };
}

/** Phrases are catalogue-sourced, so this is a last line of defence against a
 *  bad regeneration rather than against the model. */
const UNSAFE_FRAGMENT =
  /\([^)]*\)|\{[^}]+\}|\[[^\]]+\]|\$\s*\d|\bfree\b|\bguarantee|licensed|insured|\bi'?ll\b|\bwe (?:can|will)\b/i;

export function fragmentsAreSafe(asks: SelectedAsk[]): boolean {
  return asks.every((ask) => ask.fragment.length > 4 && !UNSAFE_FRAGMENT.test(ask.fragment));
}
