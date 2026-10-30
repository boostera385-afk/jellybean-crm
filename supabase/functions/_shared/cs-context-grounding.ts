/**
 * Keeping the "I saw that you are looking for ___." phrase to what the data has.
 *
 * Every other part of a composed reply already comes from the team's own
 * delivered messages; this phrase is the one the model writes, so it is the
 * one place a word nobody said could enter. Two checks hold it to the data.
 *
 * GROUNDED: each word is in this lead, or is one of the team's own words for
 * naming the work (cs-context-vocabulary.generated.ts, built from 25,068
 * delivered phrases). The team writes its phrases from exactly those two
 * sources: on a held-out fifth of its messages the rule accepts 94.6% of them.
 * A word that is neither is something the model made up.
 *
 * COHERENT: when a question refers to the item by our word for it - "how big
 * the unit is", "a picture of the area" - the phrase has to name that item.
 * The team does in 98.9% of 6,587 such messages, and in all 293 that ask
 * about "the unit". Without it a reply opened "an electrician" and then asked
 * how big "the unit" was, meaning an air conditioner it never mentioned.
 *
 * Tokenising and stemming must match scripts/build-context-vocabulary.py
 * exactly, which a test pins.
 */
import { CS_CONTEXT_VOCABULARY } from "./cs-context-vocabulary.generated.ts";
import { CS_ASK_CATALOGUE } from "./cs-ask-catalogue.generated.ts";
import { normalizeSource } from "./cs-detect.ts";

const SUFFIXES = ["ing", "es", "ed", "s"];
const VOCABULARY: ReadonlySet<string> = new Set(CS_CONTEXT_VOCABULARY.stems);
const NUMBER_WORDS: Readonly<Record<string, string>> = CS_CONTEXT_VOCABULARY.numberWords;
const DIGIT_WORDS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([word, digit]) => [digit, word]),
);

export function tokens(text: string | null | undefined): string[] {
  return (text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function stem(word: string): string {
  for (const suffix of SUFFIXES)
    if (word.length > 4 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  return word;
}

/** A lead saying "2 doors" licenses "two doors", and the reverse. */
function withNumberForms(words: string[]): string[] {
  const out = [...words];
  for (const word of words) {
    const other = NUMBER_WORDS[word] ?? DIGIT_WORDS[word];
    if (other) out.push(other);
  }
  return out;
}

/** Words of the phrase that are neither in the lead nor the team's own. */
export function ungroundedWords(phrase: string, leadParts: string[]): string[] {
  const lead = new Set(withNumberForms(leadParts.flatMap(tokens)).map(stem));
  const unsupported = tokens(phrase).filter((word) => {
    const root = stem(word);
    return !lead.has(root) && !VOCABULARY.has(root);
  });
  return [...new Set(unsupported)];
}

const OBJECT_PATTERNS = new Map(
  CS_ASK_CATALOGUE.objectPatterns.map(([key, pattern]) => [key, new RegExp(pattern, "i")]),
);

/** Whether the phrase names the object, by the same pattern detection uses. */
export function namesObject(phrase: string, object: string | null): boolean {
  if (!object) return true;
  const pattern = OBJECT_PATTERNS.get(object);
  return !pattern || pattern.test(normalizeSource(phrase));
}

/**
 * Whether a question leans on the opening to say which thing it means: it
 * calls the item by our label or the label's last word - "the unit" for an
 * AC unit, "the door" for a garage door - not by a word that names it.
 */
export function refersToObject(fragments: string[], object: string | null): boolean {
  const [singular, plural] = CS_ASK_CATALOGUE.objectLabels[object ?? ""] ?? ["", ""];
  if (!singular) return false;
  const forms = new Set([singular, plural, singular.split(" ").pop(), plural.split(" ").pop()]);
  const label = new RegExp(`\\b(?:the|your) (?:${[...forms].filter(Boolean).join("|")})\\b`, "i");
  return fragments.some((fragment) => label.test(fragment));
}

/**
 * The team's people-words, from its own commonest phrases: "a plumber" (316),
 * "a handyman" (297), "an electrician" (185). These name the person, so the
 * phrase does not take "service" after them.
 */
const TRADE_PEOPLE = new Set([
  "handyman",
  "plumber",
  "electrician",
  "painter",
  "roofer",
  "mover",
  "movers",
  "contractor",
  "carpenter",
  "locksmith",
  "technician",
  "installer",
  "cleaner",
  "specialist",
]);

/** Letters whose spoken name starts with a vowel: "an HVAC", "an LED". */
const VOWEL_SOUND_INITIAL = /^[AEFHILMNORSX8]/;

/**
 * "a {service} service", built only from the lead's own Service field and the
 * team's words "a", "an" and "service", so it is grounded by construction.
 * The team's commonest phrases have exactly this shape: "a junk removal
 * service", "a garage door repair service". Null when the lead has no service,
 * in which case nothing is composed rather than something invented.
 */
export function fallbackServiceContext(service: string | null | undefined): string | null {
  const words = (service ?? "")
    .trim()
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word))
    // Acronyms keep their capitals; everything else reads mid-sentence.
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()));
  if (!words.length) return null;
  const last = words[words.length - 1].toLowerCase();
  const named = /^services?$/.test(last) || TRADE_PEOPLE.has(last) ? words : [...words, "service"];
  const first = named[0];
  const an = /^[A-Z0-9]{2,}$/.test(first)
    ? VOWEL_SOUND_INITIAL.test(first)
    : /^[aeiou]/.test(first);
  return `${an ? "an" : "a"} ${named.join(" ")}`;
}

/**
 * Words in the Service field that are the lead's own rather than the team's
 * generic vocabulary - a brand or product name such as "Govee" or "Samsung".
 * A branded job must not be collapsed to a generic opening ("a light fixture"
 * for "Govee permanent lights"), so these have to survive into the phrase.
 * Bare numbers and very short tokens are excluded: too noisy to force.
 */
export function distinctiveServiceWords(service: string | null | undefined): string[] {
  return [
    ...new Set(
      tokens(service).filter(
        (word) => word.length >= 4 && !/^\d+$/.test(word) && !VOCABULARY.has(stem(word)),
      ),
    ),
  ];
}

/** Whether the phrase contains any of these words, matched by stem. */
export function phraseUsesAny(phrase: string, words: string[]): boolean {
  const present = new Set(tokens(phrase).map(stem));
  return words.some((word) => present.has(stem(word)));
}

/** Hints for the prompt; the checks above enforce the full list. */
export const GROUNDING_PROMPT_WORDS: readonly string[] = CS_CONTEXT_VOCABULARY.promptWords;
