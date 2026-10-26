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
import { detect, isAnswered, type Detection } from "./cs-detect.ts";

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
  /** Every ask that survived for this lead, most-asked first, one per intent:
   *  what the fit step may choose from instead of the measured pair. */
  options: SelectedAsk[];
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

/** The verbs a phrase uses to name the job it belongs to. Used to catch a
 *  phrase borrowed from the wrong job: a sofa being CLEANED must never be
 *  asked about as "items that need to be moved". */
const ACTION_WORDS: Record<string, RegExp> = {
  move: /\bmov(?:e|ed|es|ing)\b/i,
  clean: /\bclean(?:ed|s|ing)?\b|\bwash(?:ed|es|ing)?\b/i,
  install: /\binstall\w*|\bmount\w*|\bassembl\w*|\bhang\w*|\bhung\b/i,
  replace: /\breplac\w*/i,
  remove: /\bremov\w*|\bhaul\w*/i,
  repair: /\brepair\w*|\bfix\w*/i,
  maintain: /\bmaintenance\b|\binspect\w*/i,
};

/** Jobs close enough that each other's wording still reads correctly: fitting
 *  a new unit and swapping an old one are described the same way. */
const COMPATIBLE: Record<string, string[]> = {
  install: ["replace"],
  replace: ["install"],
};

/** True when a phrase names a job other than the one this lead is about. */
export function contradictsAction(phrase: string, action: string | null): boolean {
  if (!action) return false;
  const allowed = [action, ...(COMPATIBLE[action] ?? [])];
  if (allowed.some((name) => ACTION_WORDS[name]?.test(phrase))) return false;
  return Object.entries(ACTION_WORDS).some(
    ([name, pattern]) => !allowed.includes(name) && pattern.test(phrase),
  );
}

const singular = (noun: string) => (/[^s]s$/.test(noun) ? noun.slice(0, -1) : noun);

/**
 * Whether the customer wrote this word, as a whole word or its plural.
 *
 * Whole words matter: the old prefix match read "painters" as the noun
 * "paint", and 1,034 drafts asked for "the size of the paint that needs to be
 * painted". A plural is still allowed, so "porches" matches "porch".
 */
function mentions(word: string, sources: string): boolean {
  const forms = /[^aeiou]y$/i.test(word)
    ? `(?:${word}|${word.slice(0, -1)}ies)`
    : `${word}(?:e?s)?`;
  return new RegExp(`\\b${forms}\\b`, "i").test(sources);
}

/**
 * The noun to put in the slot: the customer's word where it differs from ours.
 *
 * One pattern covers several words for the same thing - deck/patio/porch,
 * concrete/driveway/sidewalk/slab - and only one of them is the catalogue
 * label. Substituting only when the label itself is ABSENT from the post keeps
 * every attested phrase intact and changes solely the cases that were wrong:
 * a porch called "the deck", a concrete slab called "the driveway", a French
 * drain called "the sink".
 */
export function labelFor(object: string | null, sources: string, wantPlural: boolean): string {
  const [sing, plur] = CS_ASK_CATALOGUE.objectLabels[object ?? ""] ?? ["", ""];
  const fallback = wantPlural ? plur : sing;
  if (!object || !sources) return fallback;
  const head = sing.split(" ").pop() ?? "";
  if (!head || mentions(head, sources)) return fallback;
  // objectNouns holds only words the team itself puts in this slot, so a word
  // for the JOB ("paint", "pressure wash") can no longer stand in for the thing.
  const used = (CS_ASK_CATALOGUE.objectNouns[object] ?? []).find((noun) =>
    mentions(singular(noun), sources),
  );
  if (!used) return fallback;
  if (!wantPlural) return singular(used);
  // The team's own plural, or ours: never a made-up one ("furnitures").
  return CS_ASK_CATALOGUE.objectNounPlurals[object]?.[used] ?? fallback;
}

function render(phrase: string, object: string | null, sources: string): string | null {
  const filled = phrase
    .replace(/\{objects\}/g, labelFor(object, sources, true))
    .replace(/\{object\}/g, labelFor(object, sources, false))
    .replace(/\s+/g, " ")
    .trim();
  // An unfilled slot would reach a customer as "{object}". Drop the ask rather
  // than send a placeholder; the next candidate takes the slot.
  return filled.includes("{") || !filled ? null : filled;
}

/**
 * The team's phrase for this ask, and which object it is scoped to.
 *
 * Most specific first: the phrase measured for this object doing THIS job,
 * then the object's phrase whatever the job, then an object-free generic. A
 * candidate naming a different job is skipped rather than sent, and an
 * object-bound intent is dropped entirely rather than falling back to a vague
 * generic ("let me know the size" - of what?).
 */
export function resolveWording(
  intent: AskIntent,
  object: string | null,
  action: string | null,
  sources = "",
): { phrase: string; object: string | null } | null {
  const scoped = object && action ? `${intent}|${object}|${action}` : "";
  const objectForms = [
    scoped ? CS_ASK_CATALOGUE.wordingByAction[scoped] : undefined,
    object ? CS_ASK_CATALOGUE.wording[`${intent}|${object}`] : undefined,
  ];
  for (const entry of objectForms) {
    if (!entry) continue;
    const phrase = render(entry.phrase, object, sources);
    if (phrase && !contradictsAction(phrase, action)) return { phrase, object };
  }
  if (OBJECT_BOUND_INTENTS.has(intent)) return null;
  const generic = CS_ASK_CATALOGUE.genericWording[intent];
  if (!generic) return null;
  const phrase = render(generic.phrase, null, sources);
  return phrase && !contradictsAction(phrase, action) ? { phrase, object: null } : null;
}

/** Phrase only; see resolveWording. */
export function wordingFor(
  intent: AskIntent,
  object: string | null,
  action: string | null = null,
  sources = "",
): string | null {
  return resolveWording(intent, object, action, sources)?.phrase ?? null;
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
    if (
      entry.intent === "OWNERSHIP" &&
      ["clean", "maintain", "move", "remove"].includes(detection.action ?? "")
    )
      continue;
    if (isAnswered(entry.intent, detection, targetObject, sources)) {
      suppressed.push(entry.intent);
      continue;
    }
    const resolved = resolveWording(entry.intent, targetObject, detection.action, sources);
    if (!resolved) continue;
    let { phrase: fragment, object } = resolved;
    // Where to collect from and where to take it depends on the JOB, not on
    // the item being carried. The team asks a move for both ends whatever the
    // item - 66% of 458 delivered moves - so a fridge or a hot tub being moved
    // gets the moving address rather than the fridge's single one. Decided
    // here, beside the same-property rule below, so that rule still wins.
    if (entry.intent === "ADDRESS" && detection.action === "move" && !detection.sameSite) {
      const move =
        CS_ASK_CATALOGUE.wordingByAction["ADDRESS|furniture_move|move"] ??
        CS_ASK_CATALOGUE.wording["ADDRESS|furniture_move"];
      const phrase = move ? render(move.phrase, targetObject, sources) : null;
      if (phrase) fragment = phrase;
    }
    // Moving inside one property is not a route: fall back to the plain
    // address ask rather than requesting a drop-off the job does not have.
    if (entry.intent === "ADDRESS" && detection.sameSite && /pick.?up/i.test(fragment)) {
      const plain = resolveWording("ADDRESS", null, detection.action, sources);
      if (!plain) continue;
      fragment = plain.phrase;
      object = null;
    }
    // An off-track door does not establish a broken spring: never introduce a
    // replacement component the customer has never mentioned. This is a
    // separate rule from the action guard above - it is about not inventing a
    // part, not about naming the wrong job.
    if (entry.intent === "OWNERSHIP") {
      const part = /\breplacement ([a-z][a-z-]*)/i.exec(fragment)?.[1];
      if (part && !new RegExp(`\\b${part.replace(/s$/, "")}s?\\b`, "i").test(sources)) continue;
    }
    candidates.push({ entry, fragment, object });
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
 * When no measured pair survives, two distinct useful surviving facts are
 * preferred. Only when no safe pair remains is one ask sent, weighted by how
 * often that intent stood alone. An answered fact is never reinstated.
 */
export function selectAsks(
  detection: Detection,
  service: string | null | undefined,
  targetObject: string | null,
  sources: string,
): AskSelection {
  // The post may use an inflection absent from the measured verb patterns
  // (e.g. lights "hung"). An explicit service action can fill that gap, but a
  // generic "handyman service" is NOT evidence of a maintenance job.
  if (!detection.action && service?.trim()) {
    const inferred = detect([service]).action;
    if (inferred && (inferred !== "maintain" || /maintenance|inspect|tune.?up/i.test(service))) {
      detection = { ...detection, action: inferred };
    }
  }
  const { key, ladder } = resolveLadder(targetObject, detection.action, service, detection.objects);
  const { candidates, suppressed } = candidatesFor(ladder, detection, targetObject, sources);
  // A narrow ladder may contain only facts already supplied (e.g. an off-track
  // door with address and timing known). Safe photo/measurement phrases that
  // were measured for the same building object can still supply useful asks.
  // Do not extrapolate appliance dimensions or invent unmeasured wording.
  if (
    candidates.length < 2 &&
    targetObject &&
    [
      "garage_door",
      "door",
      "window",
      "drywall",
      "fence",
      "deck",
      "roof",
      "gutter",
      "floor",
      "paint",
      "concrete",
    ].includes(targetObject)
  ) {
    const extras: LadderEntry[] = (["PHOTO", "SIZE"] as AskIntent[])
      .filter(
        (intent) =>
          !candidates.some((c) => c.entry.intent === intent) &&
          CS_ASK_CATALOGUE.wording[`${intent}|${targetObject}`],
      )
      .map((intent) => ({ intent, askIfMissing: 0.001 }));
    const fallback = candidatesFor(
      { n: ladder.n, entries: extras },
      detection,
      targetObject,
      sources,
    );
    candidates.push(...fallback.candidates);
    suppressed.push(...fallback.suppressed);
  }
  const ranked = [...candidates].sort((a, b) => b.entry.askIfMissing - a.entry.askIfMissing);
  const take = (candidate: Candidate): SelectedAsk => ({
    intent: candidate.entry.intent,
    object: candidate.object,
    fragment: candidate.fragment,
  });
  const byIntent = new Map(candidates.map((candidate) => [candidate.entry.intent, candidate]));
  const options = ranked
    .filter((c, i) => ranked.findIndex((o) => o.entry.intent === c.entry.intent) === i)
    .map(take);

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
        options,
      };
    }
  }
  // Prefer two useful remaining facts for first contact even if this exact
  // safe pair was rare in the export. Never force an answered fact or two
  // overlapping scope/problem questions merely to fill the second slot.
  for (const first of ranked) {
    if (first.entry.intent === "ADDRESS") continue;
    const second = ranked.find(
      (candidate) =>
        candidate.entry.intent !== first.entry.intent &&
        !(
          [first.entry.intent, candidate.entry.intent].includes("SCOPE") &&
          [first.entry.intent, candidate.entry.intent].includes("PROBLEM")
        ),
    );
    if (second)
      return {
        asks: [take(first), take(second)],
        ladderKey: key,
        suppressed: [...new Set(suppressed)],
        options,
      };
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
    options,
  };
}

/** Phrases are catalogue-sourced, so this is a last line of defence against a
 *  bad regeneration rather than against the model. */
const UNSAFE_FRAGMENT =
  /\([^)]*\)|\{[^}]+\}|\[[^\]]+\]|\$\s*\d|\bfree\b|\bguarantee|licensed|insured|\bi'?ll\b|\bwe (?:can|will)\b/i;

export function fragmentsAreSafe(asks: SelectedAsk[]): boolean {
  return asks.every((ask) => ask.fragment.length > 4 && !UNSAFE_FRAGMENT.test(ask.fragment));
}
