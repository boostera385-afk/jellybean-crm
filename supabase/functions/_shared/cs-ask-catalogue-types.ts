/**
 * Shape of the generated ask catalogue.
 *
 * Written by scripts/build-ask-catalogue.py from an export of delivered leads.
 * Keep this file in step with the payload that script assembles; it is the only
 * hand-maintained description of the generated module.
 */

/** Ask intents the catalogue can select. OTHER is deliberately absent: it is a
 *  measurement bucket in the generator, never something to send a customer. */
export const ASK_INTENTS = [
  "PHOTO",
  "ADDRESS",
  "SIZE",
  "PROBLEM",
  "BRAND/MODEL",
  "AVAILABILITY",
  "OWNERSHIP",
  "QUANTITY",
  "STORIES",
  "SCOPE",
] as const;
export type AskIntent = (typeof ASK_INTENTS)[number];

export type LadderEntry = {
  intent: AskIntent;
  /** Share of rows where the fact was missing and the team still asked for it. */
  askIfMissing: number;
  /** Share of rows where the customer HAD supplied it and the team asked anyway.
   *  Absent when too few rows carried the fact to measure. */
  askIfKnown?: number;
};

export type Ladder = { n: number; entries: LadderEntry[] };

/** `share` is this pair's frequency among the two-ask messages it was measured
 *  over - all rows for the global list, one ladder key's rows for pairsByKey. */
export type AskPair = { slot1: AskIntent; slot2: AskIntent; share: number };

export type AskCatalogue = {
  meta: { rows: number; minRows: number; minRate: number; hardGuards: AskIntent[] };
  /** Ordered, masking object patterns: the first match claims its span. */
  objectPatterns: [string, string][];
  /** object key -> [singular, plural] as the team writes it to customers.
   *  These fill the `{object}` / `{objects}` slots in a wording phrase. */
  objectLabels: Record<string, [string, string]>;
  /** Action patterns, applied only after object spans are masked out. */
  actionPatterns: [string, string][];
  factPatterns: Record<string, string>;
  photoNegation: string;
  /** Keyed `object|action`, `object`, `svc:<serviceKey>` or `*`. */
  ladders: Record<string, Ladder>;
  /** Global ordered pairs, most-used first. ADDRESS never appears as slot1. */
  pairs: AskPair[];
  /** Ordered pairs measured within one ladder key, most-used first. The pair a
   *  sub-category leads with is not the one its individual rates imply, so this
   *  is consulted before the global list. */
  pairsByKey: Record<string, AskPair[]>;
  solo: Partial<Record<AskIntent, number>>;
  /** Keyed `INTENT|object`; phrase may contain a single `{object}` slot. */
  wording: Record<string, { phrase: string; n: number }>;
  genericWording: Record<string, { phrase: string; n: number }>;
};
