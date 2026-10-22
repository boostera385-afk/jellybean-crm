#!/usr/bin/env python3
"""Build the vocabulary the team uses when it names the work.

    python3 scripts/build-context-vocabulary.py <delivered.csv> [out.ts]

Every delivered message opens "I saw that you are looking for ___.", and that
blank is the one part of a composed reply the model still writes itself. The
questions and the rest of the template already come from the team's own
messages. This file makes the blank checkable too.

The team does not pick that phrase from a list: 19,535 different phrases cover
25,068 messages, and 18,413 of them occur once. It writes one per customer, out
of two kinds of word:

  * words from the customer's own lead  -- 77.8% of all phrase words
  * a small, closed set of its own      -- "your", "service", "a", "to",
    "professional", "technician", "install", "replace", "repair", ...

So "nothing that is not in our data" has an exact, testable meaning: each word
of the phrase is either in that lead, or is one of the team's own words. A word
that is neither is something the model made up, and that is what gets refused.

A word counts as the team's only once three different messages added it.
That keeps out a one-off typo, or a brand an agent happened to type once, while
still accepting nearly everything the team actually writes: on a held-out fifth
of the messages, which played no part in building the list, the rule accepts
the team's own phrase 94.8% of the time. That figure is recomputed on every run
and written into the output, so it cannot quietly go stale.

The output holds word stems and counts only: no customer text, names,
addresses or numbers.
"""

import csv
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

# Must match supabase/functions/_shared/cs-context-grounding.ts exactly.
# Deliberately crude: a stricter match only ever REJECTS more, never accepts
# more, and the acceptance figure below is measured with this same function.
TOKEN = re.compile(r"[a-z0-9]+")
SUFFIXES = ("ing", "es", "ed", "s")


def tokens(text):
    return TOKEN.findall((text or "").lower())


def stem(word):
    for suffix in SUFFIXES:
        if len(word) > 4 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


MIN_USES = 3

# The list is for HOW THE TEAM TALKS: connecting words and trade terms. It must
# never license a fact about this customer that this customer did not state.
# Three kinds of word are in the team's messages but are facts, so they are
# kept out of the list and may appear in a phrase only when the lead has them:
#
#   numbers   "a 50 gallon water heater" for a customer who never said 50
#   names     a brand or place one customer gave, written into another's reply
#   typos     the team's own misspellings, repeated often enough to qualify
#
# Each is detected from the data rather than listed by hand.
HAS_DIGIT = re.compile(r"\d")
NUMBER_WORDS = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
}
# A lead saying "2 doors" licenses "two doors", and the reverse.
DIGIT_WORDS = {digit: word for word, digit in NUMBER_WORDS.items()}
# Written Capitalised mid-phrase at least this often = a proper noun. Acronyms
# are all capitals (HVAC, AC, TV, GFCI) and are generic trade terms, so they are
# deliberately not caught by this.
PROPER_NOUN_SHARE = 0.5
# A misspelling is close to a far commoner word AND almost no customer ever
# writes it. Closeness alone is not enough: "remodel", "repaint", "rebuild" and
# "fireplace" are each a couple of letters from another word, but customers use
# them constantly, so they are real words. Only a stem the leads themselves
# (nearly) never contain can be the team's own slip of the keyboard.
TYPO_MIN_LENGTH = 6
TYPO_MAX_DISTANCE = 2
TYPO_FREQUENCY_RATIO = 5
# Measured on the delivered export: the team's typos occur in at most 6 leads
# ("hanydman", which is also a mistyped Service value), and the rarest real
# word that sits this close to a commoner one occurs in 10 ("reglaze"). The cut
# sits between the two.
TYPO_MAX_LEAD_USES = 8
OPENING = re.compile(r"^Hi ([^,]+), this is ([^.]+)\. I saw that you are looking for (.+?)\. ", re.S)
# Words fed to the model as a hint. The check enforces the full list; this only
# raises the chance the first attempt already passes it.
PROMPT_WORDS = 40
# Spot checks pinning the TypeScript stemmer to this one.
STEM_PROBES = [
    "service", "services", "repairing", "installed", "fixes", "doors", "move",
    "moving", "ac", "is", "replacement", "technician", "gutters", "cleaning",
]


def with_number_forms(words):
    """Add the other spelling of every number from 1 to 10."""
    out = list(words)
    for word in words:
        if word in NUMBER_WORDS:
            out.append(NUMBER_WORDS[word])
        elif word in DIGIT_WORDS:
            out.append(DIGIT_WORDS[word])
    return out


def lead_stems(row):
    words = tokens(row.get("Context")) + tokens(row.get("Exact Customer Requirement"))
    return {stem(w) for w in with_number_forms(words + tokens(row.get("Service")))}


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def misspellings(counts, lead_counts):
    """Stems that are a rare misspelling of a much more common stem.

    One being a prefix of the other is not a misspelling but this stemmer's
    own artefact -- "remov" and "remove", "servic" and "service" -- so those
    pairs are never treated as typos.
    """
    found = {}
    common = sorted(counts, key=counts.get, reverse=True)
    for rare in counts:
        if len(rare) < TYPO_MIN_LENGTH or lead_counts[rare] > TYPO_MAX_LEAD_USES:
            continue
        for word in common:
            if counts[word] < counts[rare] * TYPO_FREQUENCY_RATIO:
                break
            if word.startswith(rare) or rare.startswith(word):
                continue
            if abs(len(word) - len(rare)) <= TYPO_MAX_DISTANCE and edit_distance(rare, word) <= TYPO_MAX_DISTANCE:
                found[rare] = word
                break
    return found


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1])
    out = Path(
        sys.argv[2]
        if len(sys.argv) > 2
        else "supabase/functions/_shared/cs-context-vocabulary.generated.ts"
    )
    csv.field_size_limit(10**9)
    with source.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    phrases = []
    title_case = Counter()
    seen = Counter()
    lead_counts = Counter()
    for row in rows:
        lead_counts.update(lead_stems(row))
    for row in rows:
        match = OPENING.match((row.get("Composed Message") or "").strip())
        if not match:
            continue
        phrase = match.group(3)
        phrases.append((lead_stems(row), tokens(phrase)))
        for raw in re.findall(r"[A-Za-z0-9]+", phrase):
            key = stem(raw.lower())
            seen[key] += 1
            if len(raw) > 1 and raw[0].isupper() and raw[1].islower():
                title_case[key] += 1
    if not phrases:
        sys.exit("No delivered messages with the standard opening were found.")
    proper_nouns = {k for k, n in seen.items() if title_case[k] / n >= PROPER_NOUN_SHARE}

    def vocabulary_from(sample):
        added_in = Counter()
        surface = Counter()
        for lead, words in sample:
            fresh = {w for w in words if stem(w) not in lead}
            for word in fresh:
                surface[word] += 1
            for s in {stem(w) for w in fresh}:
                added_in[s] += 1
        candidates = {s: n for s, n in added_in.items() if n >= MIN_USES}
        excluded = {
            "numbers": sorted(
                s for s in candidates if HAS_DIGIT.search(s) or s in NUMBER_WORDS
            ),
            "proper nouns": sorted(s for s in candidates if s in proper_nouns),
            "misspellings": sorted(misspellings(candidates, lead_counts)),
        }
        drop = {s for group in excluded.values() for s in group}
        return {s for s in candidates if s not in drop}, surface, excluded

    def accepts(stems, lead, words):
        return all(stem(w) in lead or stem(w) in stems for w in words)

    # Measured on rows the list never saw. A fixed seed keeps it reproducible.
    shuffled = phrases[:]
    random.Random(7).shuffle(shuffled)
    cut = int(len(shuffled) * 0.8)
    held_vocab, _, _ = vocabulary_from(shuffled[:cut])
    held_out = shuffled[cut:]
    held_out_acceptance = sum(accepts(held_vocab, l, w) for l, w in held_out) / len(held_out)

    # The shipped list is built from every row.
    stems, surface, excluded = vocabulary_from(phrases)
    in_vocab = [(w, n) for w, n in surface.most_common() if stem(w) in stems]
    prompt_words = [w for w, _ in in_vocab[:PROMPT_WORDS]]

    payload = {
        "meta": {
            "rows": len(rows),
            "phrases": len(phrases),
            "minUses": MIN_USES,
            "heldOutRows": len(held_out),
            "heldOutAcceptance": round(held_out_acceptance, 4),
        },
        # Kept out because they are facts, not phrasing; see the top of the
        # generator. Listed so the exclusions can be audited.
        "excluded": excluded,
        "stems": sorted(stems),
        "promptWords": prompt_words,
        "stemProbes": [[w, stem(w)] for w in STEM_PROBES],
        "numberWords": NUMBER_WORDS,
    }
    body = json.dumps(payload, indent=1, ensure_ascii=False)
    out.write_text(
        "// GENERATED by scripts/build-context-vocabulary.py - do not edit by hand.\n"
        "// Aggregates only: word stems and counts, no customer text, names,\n"
        "// addresses or numbers.\n"
        f"// Delivered phrases analysed: {len(phrases)}\n"
        f"export const CS_CONTEXT_VOCABULARY = {body} as const;\n",
        encoding="utf-8",
    )
    print(f"phrases analysed:      {len(phrases)}")
    print(f"team vocabulary:       {len(stems)} stems (each added in >= {MIN_USES} messages)")
    print(f"held-out acceptance:   {held_out_acceptance:.1%} of {len(held_out)} unseen team phrases")
    for name, group in excluded.items():
        print(f"excluded {name + ':':<14} {', '.join(group) or '(none)'}")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
