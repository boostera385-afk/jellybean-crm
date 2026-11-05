/**
 * Last pass over a composed first reply: fixes the small, repeated slips seen
 * in a month of real drafts (Oct-Nov 2026, ~2,850 AI drafts), without a model.
 *
 *   "share picture of the repair area"     -> "share a picture of ..."     (89)
 *   "let me know do you already have ..."  -> "let me know if you ..."     (61)
 *   "panasonic microwave", "govee lights"  -> "Panasonic", "Govee"         (40)
 *   "christmas lights"                     -> "Christmas lights"           (31)
 *   double spaces                                                          (30)
 *   "what the issue you facing with dryer" -> "what issue you are facing with your dryer"
 *   "as its stopped cooling", "lights needs", "that are suddenly stopped"
 *   "a handyman service for painting ... installation service" (service twice)
 *   "and and picture of it" (small word written twice)
 *
 * Every rule is a narrow, literal correction of wording the team would never
 * send; none adds a fact. Anything it does not recognise is left exactly as
 * composed. No database, env or SDK imports.
 */

/** Names written with a capital (or in capitals) that drafts lowercased. */
const PROPER_NOUNS: Record<string, string> = {
  christmas: "Christmas",
  thanksgiving: "Thanksgiving",
  halloween: "Halloween",
  panasonic: "Panasonic",
  maytag: "Maytag",
  whirlpool: "Whirlpool",
  samsung: "Samsung",
  kenmore: "Kenmore",
  frigidaire: "Frigidaire",
  bosch: "Bosch",
  kitchenaid: "KitchenAid",
  electrolux: "Electrolux",
  amana: "Amana",
  hotpoint: "Hotpoint",
  govee: "Govee",
  wayfair: "Wayfair",
  ikea: "IKEA",
  liftmaster: "LiftMaster",
  chamberlain: "Chamberlain",
  rheem: "Rheem",
  trane: "Trane",
  lennox: "Lennox",
  lg: "LG",
  ge: "GE",
  tv: "TV",
  tvs: "TVs",
};

/** Things a "what issue you are facing with ___" question is about. */
const ITEMS =
  "dryer|washer|washing machine|fridge|refrigerator|freezer|microwave|oven|stove|range|dishwasher|" +
  "opener|garage door|door|ac|furnace|heater|water heater|toilet|sink|faucet|disposal|ice maker";

const rules: Array<[RegExp, string]> = [
  // A small word written twice: "the size of the door and and picture of it".
  [/\b(and|the|a|an|of|to|your|for|with)\s+\1\b/gi, "$1"],
  // Articles the AI's question fitting dropped.
  [/\b(share|send me|send|and) picture of\b/gi, "$1 a picture of"],
  [/\b(share|send me|send) picture\b(?! of)/gi, "$1 a picture"],
  // "let me know do you ..." is not English; the team writes "let me know if".
  [/\blet me know do you\b/gi, "let me know if you"],
  [/\blet me know (does|is|are) (it|the|your)\b/gi, "let me know if $2"],
  // "what (the) issue you facing" -> "what issue you are facing".
  [/\bwhat the issue (you|you are) facing\b/gi, "what issue you are facing"],
  [/\bissue you facing\b/gi, "issue you are facing"],
  [new RegExp(`\\bfacing with (${ITEMS})\\b`, "gi"), "facing with your $1"],
  // Agreement slips.
  [/\bas its stopped\b/gi, "as it has stopped"],
  [/\bthat are suddenly stopped\b/gi, "that suddenly stopped"],
  [/\bthat are stopped\b/gi, "that stopped"],
  [/\blights needs\b/gi, "lights need"],
  [/\bwindows needs\b/gi, "windows need"],
  // "a handyman service for X, Y and Z service" -> drop the second "service".
  [/(\bservice for [^.?!]*?) service(?=[.?!,])/gi, "$1"],
];

/** "and" inside a "let me know if ..." clause continues with "if" too. */
function fixDoYouChains(text: string): string {
  return text.replace(/(\blet me know (?:if|whether)\b[^.?!]*?) and do you\b/gi, "$1 and if you");
}

export function polishComposedMessage(text: string): string {
  let out = text.replace(/[ \t]+/g, " ").replace(/ +([,.?!])/g, "$1");
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  out = fixDoYouChains(out);
  out = out.replace(/\b[a-z]+\b/gi, (word) => {
    const proper = PROPER_NOUNS[word.toLowerCase()];
    // Only fix a word that is wholly lowercase: "Ge" or "GE" typed by a
    // person is left alone, and so is a capitalised word mid-name.
    return proper && word === word.toLowerCase() ? proper : word;
  });
  return out.trim();
}
