#!/usr/bin/env python3
"""Build the CS ask catalogue from an export of delivered leads.

    python3 scripts/build-ask-catalogue.py <delivered.csv> [out.ts]

The export needs the columns `Customer Name`, `Context`,
`Exact Customer Requirement`, `Service` and `Composed Message`. Raw customer
data is never committed; only the aggregates below are written out.

This script is the SINGLE SOURCE OF TRUTH for the detection taxonomy. The
object/action/fact patterns are emitted into the generated TypeScript module
and consumed from there by cs-detect.ts, so the runtime cannot drift away from
the data the catalogue was measured on. Editing a pattern here and re-running
is the only supported way to change it.

What it measures, and why each part exists:

  ladders   Per (object, action), per object, per service and globally: which
            ask intents the team used, how often they asked when the fact was
            MISSING, and how often they still asked when the customer had
            already supplied it. The second number is what makes a ladder a
            policy rather than a popularity contest.

  pairs     The ordered (slot 1, slot 2) combinations that actually occur.
            The team's pair grammar is rigid - address and availability are
            terminal, intents never repeat - so a whitelist built from real
            pairs removes incoherent combinations by construction.

  solo      Which intents stood alone in a one-ask message.

  wording   intent x object -> the team's own phrase, with the object as a
            {object} slot. This is what keeps generated messages grammatical
            and in-voice: the model never writes the ask, it only picks it.

Facts where the delivered data shows no suppression at all (availability,
ownership, supplied photos, storeys) are tagged `hard` so the runtime
suppresses them in code instead of inheriting the habit.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# --------------------------------------------------------------------------
# Taxonomy. Order is significant: the first pattern to match a span claims it
# and the span is masked out, so "garage door" never also counts as "door" and
# "dryer vent" never also counts as "dryer". Compound and specific objects
# must stay above the generic ones they contain.
#
# Each entry is (key, pattern, singular label, plural label). The labels are
# the words the team actually writes to customers, which is not always derivable
# from the key: light_fixture is "lights", furniture_move is "items". They fill
# the {object} / {objects} slots in a catalogue phrase.
# --------------------------------------------------------------------------
OBJECTS: list[tuple[str, str, str, str]] = [
    ("garage_door", r"garage door|garage opener", "garage door", "garage doors"),
    ("dryer_vent", r"dryer vent|air duct|\bducts?\b", "air duct", "air ducts"),
    ("water_heater", r"water heater|tankless", "water heater", "water heaters"),
    ("hot_tub", r"hot tub|jacuzzi|\bspa\b", "hot tub", "hot tubs"),
    ("christmas_lights", r"christmas light|holiday light", "light", "lights"),
    ("ceiling_fan", r"ceiling fan|exhaust fan", "fan", "fans"),
    ("garbage_disposal", r"garbage disposal", "garbage disposal", "garbage disposals"),
    (
        "electrical_panel",
        r"electrical panel|breaker (?:panel|box)|\bbreakers?\b|\bwiring\b",
        "panel",
        "panels",
    ),
    ("pressure_wash", r"pressure wash|power wash|soft wash", "area", "areas"),
    ("washer", r"wash(?:ing)? machine|\bwasher\b", "washing machine", "washing machines"),
    ("dryer", r"\bdryer\b", "dryer", "dryers"),
    ("refrigerator", r"refrigerator|\bfridge\b|freezer|ice maker", "refrigerator", "refrigerators"),
    ("dishwasher", r"dishwasher", "dishwasher", "dishwashers"),
    ("oven_stove", r"\boven\b|\bstove\b|\brange\b|cooktop", "oven", "ovens"),
    ("microwave", r"microwave", "microwave", "microwaves"),
    ("ac_unit", r"air condition\w*|\bhvac\b|mini.?split|condenser|\ba/?c\b", "ac unit", "ac units"),
    ("furnace_heater", r"furnace|heat pump|\bboiler\b|\bheater\b", "heater", "heaters"),
    ("faucet", r"faucet|spigot", "faucet", "faucets"),
    ("toilet", r"toilet|commode", "toilet", "toilets"),
    ("sink_drain", r"\bsink\b|\bdrains?\b|\bclog\w*", "sink", "sinks"),
    ("roof", r"\broof\w*", "roof", "roofs"),
    ("pipe_leak", r"\bpipes?\b|\bplumbing\b|\bleak\w*", "pipe", "pipes"),
    ("shower_tub", r"shower|bathtub|\btubs?\b", "shower", "showers"),
    ("door", r"\bdoors?\b|\bgates?\b", "door", "doors"),
    ("window", r"\bwindows?\b", "window", "windows"),
    ("drywall", r"drywall|sheetrock|\bplaster\w*", "drywall", "drywall"),
    ("paint", r"\bpaint\w*", "area", "areas"),
    ("floor", r"\bfloor\w*|\btiles?\b|laminate|hardwood|vinyl plank", "floor", "floors"),
    ("carpet", r"\bcarpets?\b|\brugs?\b|upholstery", "carpet", "carpets"),
    ("gutter", r"\bgutters?\b|downspout", "gutter", "gutters"),
    ("fence", r"\bfences?\b|\bfencing\b", "fence", "fences"),
    ("screen", r"\bscreens?\b|\bscreening\b", "screen", "screens"),
    ("deck", r"\bdecks?\b|\bpatios?\b|\bporch\w*", "deck", "decks"),
    ("concrete", r"concrete|\bdriveway\w*|sidewalk|\bslab\b", "driveway", "driveways"),
    ("light_fixture", r"\blights?\b|\blighting\b|chandelier|recessed|\bled\b", "light", "lights"),
    ("outlet_switch", r"\boutlets?\b|\bswitch\w*|receptacle", "outlet", "outlets"),
    ("tv_mount", r"\btv\b|television", "tv", "tvs"),
    ("cabinet", r"cabinet\w*|countertop|\bvanity\b", "cabinet", "cabinets"),
    ("pool", r"\bpool\b", "pool", "pools"),
    ("sprinkler", r"sprinkler|irrigation", "sprinkler system", "sprinkler systems"),
    ("tree", r"\btrees?\b|\bstump\w*|\bbranch\w*|\bshrubs?\b", "tree", "trees"),
    (
        "pest",
        r"\bpests?\b|roach|termite|bed bug|rodent|\bmice\b|\brats?\b|\bants?\b|wasp|hornet",
        "pest",
        "pests",
    ),
    (
        "junk",
        # "clean out" is only a clearance when it is a place being cleared: on a
        # plumbing lead it is the drain fitting, and those posts were being asked
        # for "a picture of the junk items".
        r"\bjunk\b|\bdebris\b|\btrash\b|\bhaul\w*"
        r"|(?:estate|house|home|garage|attic|basement|apartment|yard)\s*clean.?out",
        "junk",
        "junk",
    ),
    ("furniture_assembly", r"assembl\w*|put together|\bikea\b", "item", "items"),
    (
        "furniture_move",
        r"\bmov(?:e|ing|ers)\b|\bsofa\b|\bcouch\b|\bmattress\b|\bpiano\b|\bfurniture\b",
        "item",
        "items",
    ),
    ("chimney", r"chimney|fireplace", "chimney", "chimneys"),
    ("insulation", r"insulation|\battic\b", "attic", "attics"),
    ("blinds", r"\bblinds?\b|\bcurtains?\b|\bshades?\b", "blind", "blinds"),
    ("wallpaper", r"wallpaper", "wallpaper", "wallpaper"),
    ("mailbox", r"mailbox", "mailbox", "mailboxes"),
    ("shed", r"\bshed\b|playset|swing set|trampoline", "shed", "sheds"),
    ("remodel", r"remodel\w*|renovat\w*", "area", "areas"),
]
OBJECT_LABELS = {key: (singular, plural) for key, _, singular, plural in OBJECTS}


def pattern_nouns(pattern: str) -> list[str]:
    """The plain nouns an object's pattern recognises, in declaration order.

    A pattern covers several words for one thing - deck/patio/porch,
    concrete/driveway/sidewalk/slab - but only one of them is the label. When
    the customer used a different one, the message should use theirs rather
    than renaming their porch a deck, so the runtime needs the full list.
    """
    nouns = []
    # An alternative containing a group is never a plain noun: it is either a
    # qualified phrase ("estate cleanout") or an inflected stem
    # (\bmov(?:e|ing|ers)\b, which would otherwise yield "mov"). Mark the
    # groups before splitting, since "|" inside one would cut it in half.
    marked = re.sub(r"\(\?:[^)]*\)", "~", pattern)
    for alternative in marked.split("|"):
        if "~" in alternative:
            continue
        # Splitting on "|" cuts through any inner group, so an alternative
        # carrying group syntax is a fragment, not a noun: "(?:estate" from
        # junk's cleanout clause once rendered "the estates items".
        if re.search(r"[(){}\[\]]|\\s", alternative):
            continue
        word = re.sub(r"\\b|\\w\*|\?|\+|\*", "", alternative).strip()
        if word and re.fullmatch(r"[a-z][a-z ]*", word) and len(word) > 2:
            nouns.append(word)
    return nouns


OBJECT_PATTERN_NOUNS = {key: pattern_nouns(pattern) for key, pattern, _, _ in OBJECTS}

# Actions are detected only AFTER object spans are masked out, so "washer"
# can no longer supply the "wash" in `clean` and "plumbing service" can no
# longer supply the "service" in `maintain`.
ACTIONS: list[tuple[str, str]] = [
    ("install", r"\binstall\w*|\bmount\w*|\bhang\w*|\bset up\b|\badd\b|\bassembl\w*"),
    # "new" is deliberately absent: "new place", "new house" and "new build"
    # are not replacement jobs, and it mis-sorted moving posts into replace.
    ("replace", r"\breplac\w*|\bswap\b"),
    ("remove", r"\bremov\w*|\btear out\b|\bdemo\w*|\bdispos\w*|\bget rid of\b"),
    ("move", r"\brelocat\w*|\bmove\b"),
    ("clean", r"\bclean\w*|\bwash\w*"),
    ("repair", r"\brepair\w*|\bfix\w*|\bbroken\b|\bnot working\b|\bwon'?t\b|\bissue\w*|\bproblem\w*"),
    ("maintain", r"\bmaintenance\b|\btune.?up\b|\binspect\w*|\bservice\b|\bcheck\b"),
]

FACTS: dict[str, str] = {
    "ADDRESS": (
        r"\b\d{1,6}[a-z]?\s+(?:[a-z0-9.'-]+\s+){1,5}"
        r"(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|"
        r"circle|cir|way|place|pl|terrace|ter|parkway|pkwy)\b"
        r"|address (?:is )?(?:on file|already (?:provided|supplied|shared))"
    ),
    "AVAILABILITY": (
        r"\b(?:today|tonight|tomorrow|asap|this (?:morning|afternoon|evening|week|weekend)|"
        r"next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b"
        r"|\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b"
        r"|within (?:the )?(?:next )?(?:day or two|\d+ days?)"
    ),
    "PROBLEM": (
        r"\b(?:not (?:working|cooling|closing|opening|heating|draining|turning on)|"
        r"no (?:heat|power|hot water|circulation)|won'?t|stopped working|leak(?:ing|s)?|"
        r"frost|off.track|broken|cracked|stuck|clogged|making noise|burning smell)\b"
    ),
    "BRAND/MODEL": (
        r"\b(?:lg|whirlpool|samsung|bosch|ge profile|ge|zline|kenmore|maytag|frigidaire|"
        r"carrier|trane|lennox|rheem|goodman|kohler|moen|delta|liftmaster|chamberlain|genie)\b"
    ),
    "SIZE": (
        r"\b\d+(?:\.\d+)?\s*(?:x|×|by)\s*\d+(?:\.\d+)?\b"
        r"|\b\d+\s*(?:sq\.?\s*ft|square (?:feet|foot|ft)|linear (?:feet|ft)|"
        r"ft|feet|foot|inch|inches|ton|gallon)\b"
    ),
    "PHOTO": (
        r"(?:picture|photo|image)s?\s+(?:below|attached|included|already sent)"
        r"|(?:attached|posted|sent|included|adding)\s+(?:the\s+|some\s+|a\s+few\s+)?"
        r"(?:pictures?|photos?|images?)"
        r"|see\s+(?:the\s+)?(?:picture|photo|image)"
    ),
    "QUANTITY": (
        r"\b\d+\s*(?:windows?|doors?|rooms?|outlets?|lights?|fixtures?|panels?|items?|"
        r"pieces?|boxes?|trees?|units?|fans?|cabinets?|zones?)\b"
    ),
    "OWNERSHIP": (
        r"\b(?:i|we)\s*(?:already\s*)?(?:have|bought|purchased|own|got)\b"
        r"|already have the|materials? (?:are )?supplied"
    ),
    "STORIES": r"\b(?:single|one|two|2|double|three|3)[- ]?(?:story|storey|stories)\b",
}

# A photo mention preceded by a negation is not a supplied photo.
PHOTO_NEGATION = r"\b(?:no|not|never|haven'?t|hasn'?t|didn'?t|don'?t)\s+(?:(?:yet|any|the|been|already)\s+)?$"

# Facts the delivered data suppresses correctly (measured 2x or better) can be
# driven by the learned rates. These four showed ~1.0x or inverted suppression,
# so the runtime must suppress them unconditionally instead.
HARD_GUARD_INTENTS = ["AVAILABILITY", "OWNERSHIP", "PHOTO", "STORIES"]

INTENTS = [
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
]

ASK_BLOCK = re.compile(r"[Cc]ould you kindly\s+(.*?)(?:,?\s*so (?:I|we) can|\?|$)", re.S)
ASK_SPLIT = re.compile(r"\s+and\s+(?=share|let me know|send|tell|confirm|provide|your|the)")
VERB = re.compile(r"^(?:share|let me know|send me|send|tell me|tell|confirm|provide)\b", re.I)

# Wording hygiene. A catalogue phrase is sent to real customers verbatim, so
# anything that promises, prices, embeds a specific job or carries a leftover
# placeholder is rejected at build time rather than guarded at runtime.
UNSAFE_WORDING = re.compile(
    r"\([^)]*\)|\{[^}]+\}|\[[^\]]+\]|\$\s*\d|\bfree\b|\bguarantee\w*|licensed|insured"
    r"|\bi'?ll\b|\bwe (?:can|will)\b|\bcall you\b"
    r"|\b(?:open|remove|disassemble|take apart)\b.*\b(?:panel|cover|breaker|wiring)\b"
    r"|climb (?:onto|on|up)",
    re.I,
)
# Exempted for ADDRESS, whose house phrase for moves is legitimately "pickup
# and drop off addresses". Everywhere else " and " means two asks were merged
# into one slot, which is the pattern that produced unreadable drafts.
COMPOUND_WORDING = re.compile(r"\s+and\s+", re.I)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("’", "'")).strip().lower()


def service_key(service: str) -> str:
    key = re.sub(r"\b(?:general|service|services|repair service)\b", " ", norm(service))
    key = re.sub(r"[^a-z0-9 ]+", " ", key)
    return re.sub(r"\s+", " ", key).strip()


class Detector:
    """Masking detector shared by the generator and (via the emitted patterns)
    the runtime. Returns objects in the order their patterns are declared."""

    def __init__(self) -> None:
        self.objects = [(name, re.compile(pat, re.I)) for name, pat, _, _ in OBJECTS]
        self.actions = [(name, re.compile(pat, re.I)) for name, pat in ACTIONS]
        self.facts = {name: re.compile(pat, re.I) for name, pat in FACTS.items()}
        self.photo_negation = re.compile(PHOTO_NEGATION, re.I)

    def detect(self, text: str) -> tuple[list[str], list[str], dict[str, bool]]:
        masked = text
        found: list[str] = []
        for name, pattern in self.objects:
            if pattern.search(masked):
                found.append(name)
                masked = pattern.sub(" \u0000 ", masked)
        actions = [name for name, pattern in self.actions if pattern.search(masked)]
        known: dict[str, bool] = {}
        for name, pattern in self.facts.items():
            if name == "PHOTO":
                known[name] = any(
                    not self.photo_negation.search(text[max(0, m.start() - 45) : m.start()])
                    for m in pattern.finditer(text)
                )
            else:
                known[name] = bool(pattern.search(text))
        return found, actions, known


def classify_ask(ask: str) -> str:
    a = norm(ask)
    if re.search(r"\baddress(?:es)?\b", a):
        return "ADDRESS"
    if re.search(r"picture|photo|image", a):
        return "PHOTO"
    if re.search(r"availability|best time|what time|when you would like", a):
        return "AVAILABILITY"
    if re.search(r"what issue|what problem|issue you are facing|what type of pest", a):
        return "PROBLEM"
    if re.search(r"\bbrand\b|\bmake\b|model", a):
        return "BRAND/MODEL"
    if re.search(r"size|dimension|how (?:big|large|tall|long|many square)|ceiling height|length", a):
        return "SIZE"
    if re.search(r"how many|quantity|number of", a):
        return "QUANTITY"
    if re.search(r"already have|do you have|if you own|replacement", a):
        return "OWNERSHIP"
    if re.search(r"single or double story|how many stor", a):
        return "STORIES"
    if re.search(r"what exactly needs|what needs to be done|more details", a):
        return "SCOPE"
    return "OTHER"


QUESTION_WORD = re.compile(r"^(?:what|when|where|which|who|how|whether|if|why)\b", re.I)


def ensure_verb(phrase: str) -> str:
    """Give an ask its verb back.

    A second ask in the delivered data often elides the verb because it sits
    after "and" ("share a picture of the door and your complete address"). A
    catalogue phrase has to stand on its own in either slot, so restore the
    verb the same way the team writes it when the ask comes first.
    """
    if VERB.search(phrase):
        return phrase
    return f"tell me {phrase}" if QUESTION_WORD.search(phrase) else f"share {phrase}"


def acceptable_wording(intent: str, phrase: str) -> bool:
    if not (8 <= len(phrase) <= 72):
        return False
    if UNSAFE_WORDING.search(phrase):
        return False
    # " and " in a single slot means two asks were merged. The one legitimate
    # exception is the move route, written as one ask by the team.
    if COMPOUND_WORDING.search(phrase) and not (
        intent == "ADDRESS" and re.search(r"pick.?up and drop.?off", phrase, re.I)
    ):
        return False
    # A phrase must not smuggle in a second intent's subject matter.
    if intent != "ADDRESS" and re.search(r"\baddress(?:es)?\b", phrase, re.I):
        return False
    if re.search(r"\b\d{3,}\b", phrase):
        return False
    return True


def slot_for(object_name: str, phrase: str) -> str:
    """Replace the object noun with an {object} / {objects} slot so one phrase
    serves the whole family, preserving the number the team used: "how many
    windows need to be cleaned" must not render as "how many window"."""
    singular, plural = OBJECT_LABELS.get(object_name, ("", ""))
    for label, slot in ((plural, "{objects}"), (singular, "{object}")):
        if label and re.search(rf"\b{re.escape(label)}\b", phrase, re.I):
            return re.sub(rf"\b{re.escape(label)}\b", slot, phrase, count=1, flags=re.I)
    return phrase


# Every noun the taxonomy knows, down to single words, so "how many ducts" is
# recognised as object-specific even though the label is "air duct". "area" and
# "item" are deliberately excluded: they are the generic nouns the team uses
# when it does not want to name a thing.
OBJECT_NOUNS = {
    token
    for singular, plural in OBJECT_LABELS.values()
    for label in (singular, plural)
    for token in label.split()
} - {"area", "areas", "system", "systems"}


def mentions_an_object(phrase: str) -> bool:
    """True when a phrase names a specific object, which disqualifies it as
    generic wording - a fallback must never arrive naming a refrigerator."""
    return any(re.search(rf"\b{re.escape(noun)}\b", phrase, re.I) for noun in OBJECT_NOUNS)


FILLER = re.compile(r"\b(?:your|the|a|an|me|us|some|few|complete)\b", re.I)


def intent_key(phrase: str) -> str:
    """Collapse wording variants of the same ask onto one key.

    "the pickup and drop off addresses", "provide the complete pickup and drop
    off addresses" and "share the complete pickup and drop off addresses" are
    one ask written three ways. Without this they split the vote and a rarer
    phrasing wins the slot.
    """
    key = VERB.sub("", norm(phrase))
    key = FILLER.sub(" ", key)
    key = re.sub(r"[^a-z0-9{} ]+", " ", key)
    return re.sub(r"\s+", " ", key).strip()


def pick_phrase(counter: Counter) -> tuple[str, int]:
    """Winning phrase = most common ASK (grouped by intent_key), rendered in
    that group's most common surface form."""
    groups: dict[str, Counter] = defaultdict(Counter)
    for phrase, n in counter.items():
        groups[intent_key(phrase)][phrase] += n
    best = max(groups.values(), key=lambda g: sum(g.values()))
    phrase, _ = best.most_common(1)[0]
    return phrase, sum(best.values())


# ---- nouns the team actually uses --------------------------------------
# An object's pattern recognises several words, and the runtime may put the
# customer's own word in place of the label: their "porch" stays a porch rather
# than becoming "the deck". But a pattern also contains words for the JOB, not
# the thing, and substituting one of those produced questions the team never
# wrote: "the size of the paint that needs to be painted" (1,034 drafts),
# "a picture of the pressure wash", "the assembls that need to be assembled".
#
# So a word may stand in for the label only once the team itself has put it in
# a slot that names the THING -- "a picture of the fridge", "the issue you are
# facing with your spa" -- in at least NOUN_MIN_USES messages about that object.
# Job words score 0 there and drop out on their own: paint 0, pressure wash 0,
# assembl 0, haul 0. Real synonyms stay: fridge 20, stove 25, couch 37, spa 4.
NOUN_MIN_USES = 3
THING_SLOT = (
    r"(?:pictures? of|photos? of|size of|issue you are facing with|"
    r"brand (?:name )?of|model of) (?:the|your) "
)


def noun_singular(noun: str) -> str:
    """Must match `singular` in cs-ask-policy.ts."""
    return noun[:-1] if re.search(r"[^s]s$", noun) else noun


def plural_candidates(base: str) -> list[str]:
    forms = [base + "s", base + "es"]
    if re.search(r"[^aeiou]y$", base):
        forms.append(base[:-1] + "ies")
    return forms


def attested_nouns(rows: list[dict]) -> tuple[dict, dict]:
    """Per object: the pattern nouns the team uses for the thing, and the
    plural the team writes for each. A noun with no attested plural is left
    out of the plural map, so the runtime falls back to the label's own plural
    rather than inventing "furnitures" or "vanitys"."""
    uses: dict[str, Counter] = defaultdict(Counter)
    plurals: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    for row in rows:
        if not row["objects"]:
            continue
        primary = row["objects"][0]
        text = row["ask_text"]
        for noun in OBJECT_PATTERN_NOUNS.get(primary, []):
            base = noun_singular(noun)
            forms = {noun, base, *plural_candidates(base)}
            if any(re.search(THING_SLOT + re.escape(f) + r"\b", text) for f in forms):
                uses[primary][noun] += 1
            for form in plural_candidates(base):
                if re.search(THING_SLOT + re.escape(form) + r"\b", text):
                    plurals[primary][noun][form] += 1
    object_nouns = {}
    noun_plurals = {}
    for key, nouns in OBJECT_PATTERN_NOUNS.items():
        kept = [n for n in nouns if uses[key][n] >= NOUN_MIN_USES]
        object_nouns[key] = kept
        forms = {
            n: plurals[key][n].most_common(1)[0][0]
            for n in kept
            if plurals[key][n]
        }
        if forms:
            noun_plurals[key] = forms
    return object_nouns, noun_plurals


# ---- brands from the data --------------------------------------------
# The brand list was 21 names typed by hand, so a customer who wrote
# "Thermador freezer" was asked for the brand in the sentence after we named
# it. Brands are found instead the way people write them: a word written
# Capitalised directly before an appliance -- only appliances the team asks
# the brand of -- in at least BRAND_MIN_LEADS leads, and written lower-case
# less than twice as often as Capitalised there. Ordinary words fail that last
# test by orders of magnitude ("my": 45 against 10,067), which is what makes
# the rule safe without a dictionary; so do look-alikes such as "freon",
# "hvac" and "french". The hand-typed list is kept as well.
BRAND_MIN_LEADS = 3
BRAND_MAX_LOWER_RATIO = 2
# "Asks the brand" has to mean the team does so as a matter of course for that
# object, the same bar a ladder entry has to clear. Counting any object it has
# EVER asked the brand of pulls in doors and lights, and with them the cities
# and holidays people write next to those: "in Austin", "Christmas lights".
BRAND_OBJECT_MIN_ROWS = 25
BRAND_OBJECT_MIN_RATE = 0.08
# At most one word may sit between brand and appliance ("Jenn-Air gas cooktop").
# A wider gap reached across clauses: "moving to Dallas and the dryer".
BRAND_MAX_GAP_WORDS = 1
HAND_BRANDS = [
    "lg", "whirlpool", "samsung", "bosch", "ge profile", "ge", "zline", "kenmore",
    "maytag", "frigidaire", "carrier", "trane", "lennox", "rheem", "goodman",
    "kohler", "moen", "delta", "liftmaster", "chamberlain", "genie",
]


def appliance_nouns(rows: list[dict], object_nouns: dict) -> list[str]:
    """Nouns of every object the team routinely asks the brand of.

    Built from the team-attested nouns, not the raw pattern words or the
    label: the label is a generic stand-in ("area", "unit"), and a city written
    before it ("the Marietta area", "north Miami area") looks exactly like a
    brand written before an appliance.
    """
    totals = Counter(r["objects"][0] for r in rows if r["objects"])
    asked = Counter(
        r["objects"][0] for r in rows if r["objects"] and "BRAND/MODEL" in r["intents"]
    )
    branded = {
        key
        for key, n in totals.items()
        if n >= BRAND_OBJECT_MIN_ROWS and asked[key] / n >= BRAND_OBJECT_MIN_RATE
    }
    nouns = {noun_singular(n) for key in branded for n in object_nouns.get(key, []) if n}
    return sorted(nouns, key=len, reverse=True)


def discovered_brands(source: Path, nouns: list[str]) -> list[str]:
    appliance = "|".join(re.escape(n) for n in nouns)
    before = re.compile(
        r"(?<=[a-z,] )([A-Z][A-Za-z-]+) (?:\w+ ){0,"
        + str(BRAND_MAX_GAP_WORDS)
        + r"}?(?:"
        + appliance
        + r")s?\b"
    )
    capitalised: dict[str, set] = defaultdict(set)
    lower = Counter()
    with source.open(newline="", encoding="utf-8") as handle:
        for index, row in enumerate(csv.DictReader(handle)):
            text = f"{row.get('Context') or ''} {row.get('Exact Customer Requirement') or ''}"
            for match in before.finditer(text):
                capitalised[match.group(1).lower()].add(index)
            lower.update(re.findall(r"\b[a-z][a-z-]*\b", text))
    found = {
        word
        for word, leads in capitalised.items()
        if len(leads) >= BRAND_MIN_LEADS
        and lower[word] < BRAND_MAX_LOWER_RATIO * len(leads)
        and word not in nouns
    }
    return sorted(set(HAND_BRANDS) | found, key=lambda b: (-len(b), b))


def brand_pattern(brands: list[str]) -> str:
    # Plain words only, so nothing needs escaping. The pattern is compiled by
    # JavaScript as well, where Python's re.escape output ("sub\\-zero") is not
    # guaranteed to be valid, so anything that is not a plain word is dropped
    # rather than escaped.
    plain = [b for b in brands if re.fullmatch(r"[a-z0-9]+(?:[ -][a-z0-9]+)*", b)]
    return r"\b(?:" + "|".join(plain) + r")\b"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = Path(sys.argv[1])
    out_path = Path(
        sys.argv[2]
        if len(sys.argv) > 2
        else "supabase/functions/_shared/cs-ask-catalogue.generated.ts"
    )
    detector = Detector()

    rows = []
    with source.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            message = row.get("Composed Message") or ""
            block = ASK_BLOCK.search(message)
            if not block:
                continue
            asks = [p.strip().rstrip(".,") for p in ASK_SPLIT.split(norm(block.group(1))) if p.strip()]
            if not asks:
                continue
            text = norm(f"{row.get('Exact Customer Requirement', '')} || {row.get('Context', '')}")
            objects, actions, known = detector.detect(text)
            rows.append(
                {
                    "objects": objects,
                    "action": actions[0] if actions else None,
                    "known": known,
                    "asks": asks,
                    "ask_text": " and ".join(asks),
                    "intents": [classify_ask(a) for a in asks],
                    "service": service_key(row.get("Service", "")),
                }
            )

    if not rows:
        print("No usable rows found - check the export's column names.", file=sys.stderr)
        return 1

    object_nouns, noun_plurals = attested_nouns(rows)
    brands = discovered_brands(source, appliance_nouns(rows, object_nouns))

    # ---- ladders -------------------------------------------------------
    # asked_missing / asked_known per key. A key is only emitted once it has
    # enough rows to mean something; the runtime falls back to the next level.
    buckets: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        primary = row["objects"][0] if row["objects"] else None
        if primary:
            if row["action"]:
                buckets[f"{primary}|{row['action']}"].append(row)
            buckets[primary].append(row)
        else:
            # Posts with no identifiable object have their own profile; the
            # team falls back to scope + address there, which the all-rows
            # bucket would wash out.
            buckets["none"].append(row)
        if row["service"]:
            buckets[f"svc:{row['service']}"].append(row)
        buckets["*"].append(row)

    MIN_ROWS = 25
    MIN_RATE = 0.08
    ladders: dict[str, dict] = {}
    for key, group in buckets.items():
        if len(group) < MIN_ROWS:
            continue
        entries = []
        for intent in INTENTS:
            missing = [r for r in group if not r["known"].get(intent, False)]
            present = [r for r in group if r["known"].get(intent, False)]
            if len(missing) < 15:
                continue
            rate = sum(1 for r in missing if intent in r["intents"]) / len(missing)
            if rate < MIN_RATE:
                continue
            entry = {"intent": intent, "askIfMissing": round(rate, 4)}
            if len(present) >= MIN_ROWS:
                entry["askIfKnown"] = round(
                    sum(1 for r in present if intent in r["intents"]) / len(present), 4
                )
            entries.append(entry)
        if entries:
            entries.sort(key=lambda e: -e["askIfMissing"])
            ladders[key] = {"n": len(group), "entries": entries}

    # ---- pair grammar --------------------------------------------------
    # Measured per ladder key as well as globally, because the pair a
    # sub-category leads with is not the one its individual rates imply: a
    # window clean asks size before photos, even though photos are the more
    # frequent ask overall. Only the key's own joint distribution shows that.
    #
    # ADDRESS is never emitted as slot 1. 99 of 18,084 two-ask messages (0.5%)
    # did lead with it; they are treated as noise rather than policy, because
    # an address that opens a message reads as a demand and the team's own
    # grammar closes with it.
    def ordered_pairs(group: list[dict]) -> Counter:
        return Counter(
            (r["intents"][0], r["intents"][1])
            for r in group
            if len(r["intents"]) >= 2
            and r["intents"][0] != r["intents"][1]
            and r["intents"][0] in INTENTS
            and r["intents"][1] in INTENTS
            and r["intents"][0] != "ADDRESS"
        )

    def pair_list(counts: Counter, minimum: int) -> list[dict]:
        total = sum(counts.values())
        if not total:
            return []
        return [
            {"slot1": a, "slot2": b, "share": round(n / total, 4)}
            for (a, b), n in counts.most_common()
            if n >= minimum
        ]

    pair_counts = ordered_pairs(rows)
    two_ask = sum(pair_counts.values())
    pairs = pair_list(pair_counts, 25)
    pairs_by_key = {}
    for key, group in buckets.items():
        if key not in ladders:
            continue
        measured = pair_list(ordered_pairs(group), 5)
        if measured:
            pairs_by_key[key] = measured
    solo_counts = Counter(r["intents"][0] for r in rows if len(r["intents"]) == 1)
    solo_total = sum(solo_counts.values()) or 1
    solo = {
        intent: round(n / solo_total, 4)
        for intent, n in solo_counts.most_common()
        if intent in INTENTS and n >= 20
    }

    # ---- wording lexicon ----------------------------------------------
    lexicon: dict[str, Counter] = defaultdict(Counter)
    by_action: dict[str, Counter] = defaultdict(Counter)
    generic: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        primary = row["objects"][0] if row["objects"] else None
        singular, plural = OBJECT_LABELS.get(primary or "", ("", ""))
        for ask, intent in zip(row["asks"], row["intents"]):
            if intent not in INTENTS:
                continue
            phrase = ensure_verb(ask)
            if not acceptable_wording(intent, phrase):
                continue
            if not mentions_an_object(phrase):
                generic[intent][phrase] += 1
            if not primary:
                continue
            # On a post naming several objects the ask may well be about one of
            # the others: a door-and-paint post produced "if you already have
            # the paint". Attribute to the primary object only when the post
            # named a single object, or when the ask names that object itself.
            names_primary = any(
                label and re.search(rf"\b{re.escape(label)}\b", phrase, re.I)
                for label in (singular, plural)
            )
            if len(row["objects"]) > 1 and not names_primary:
                continue
            slotted = slot_for(primary, phrase)
            lexicon[f"{intent}|{primary}"][slotted] += 1
            # Also keyed by action, because one object's phrase is not
            # interchangeable across jobs: a sofa being CLEANED is not
            # "items that need to be moved".
            if row["action"]:
                by_action[f"{intent}|{primary}|{row['action']}"][slotted] += 1

    wording = {}
    for key, counter in lexicon.items():
        phrase, n = pick_phrase(counter)
        if n >= 3:
            wording[key] = {"phrase": phrase, "n": n}
    # A generic phrase is only emitted when the data actually contains an
    # object-free form. Where it does not, the intent simply cannot be used
    # without object-specific wording - better than inventing a phrase.
    wording_by_action = {}
    for key, counter in by_action.items():
        phrase, n = pick_phrase(counter)
        # A higher bar than the object-level lexicon: an action-scoped phrase
        # only earns its place when it is well attested, otherwise the
        # object-level phrase is the safer answer.
        if n >= 5:
            wording_by_action[key] = {"phrase": phrase, "n": n}
    generic_wording = {}
    for intent, counter in generic.items():
        phrase, n = pick_phrase(counter)
        if n >= 10:
            generic_wording[intent] = {"phrase": phrase, "n": n}

    payload = {
        "meta": {
            "rows": len(rows),
            "minRows": MIN_ROWS,
            "minRate": MIN_RATE,
            "hardGuards": HARD_GUARD_INTENTS,
        },
        "objectPatterns": [[name, pat] for name, pat, _s, _p in OBJECTS],
        "objectLabels": {k: list(v) for k, v in OBJECT_LABELS.items()},
        "objectNouns": object_nouns,
        "objectNounPlurals": noun_plurals,
        "actionPatterns": [[name, pat] for name, pat in ACTIONS],
        "factPatterns": {**FACTS, "BRAND/MODEL": brand_pattern(brands)},
        "photoNegation": PHOTO_NEGATION,
        "ladders": ladders,
        "pairs": pairs,
        "pairsByKey": pairs_by_key,
        "solo": solo,
        "wording": wording,
        "wordingByAction": wording_by_action,
        "genericWording": generic_wording,
    }

    body = json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        "// GENERATED by scripts/build-ask-catalogue.py - do not edit by hand.\n"
        "// Aggregates only: no customer text, names, addresses or phone numbers.\n"
        f"// Source rows analysed: {len(rows)}\n"
        "import type { AskCatalogue } from \"./cs-ask-catalogue-types.ts\";\n\n"
        f"export const CS_ASK_CATALOGUE = {body} as unknown as AskCatalogue;\n",
        encoding="utf-8",
    )

    print(f"rows analysed        {len(rows)}")
    print(f"ladder keys          {len(ladders)}")
    print(f"  (object,action)    {sum(1 for k in ladders if '|' in k and not k.startswith('svc:'))}")
    print(f"  object             {sum(1 for k in ladders if '|' not in k and not k.startswith('svc:') and k != '*')}")
    print(f"  service            {sum(1 for k in ladders if k.startswith('svc:'))}")
    print(f"pair grammar         {len(pairs)} global ordered pairs ({two_ask} two-ask rows)")
    print(f"  per-ladder pairs   {len(pairs_by_key)} keys")
    print(f"solo intents         {len(solo)}")
    print(
        f"wording entries      {len(wording)} object + {len(wording_by_action)} object+action"
        f" + {len(generic_wording)} generic"
    )
    print(f"written              {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
