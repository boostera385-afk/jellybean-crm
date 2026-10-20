import { describe, it, expect } from "vitest";
import { CS_ASK_CATALOGUE } from "../../supabase/functions/_shared/cs-ask-catalogue.generated";
import {
  ASK_INTENTS,
  type AskIntent,
} from "../../supabase/functions/_shared/cs-ask-catalogue-types";
import {
  brandKnownFor,
  detect,
  isAnswered,
  normalizeSource,
  HARD_GUARDS,
} from "../../supabase/functions/_shared/cs-detect";
import {
  contradictsAction,
  fragmentsAreSafe,
  resolveLadder,
  selectAsks,
  serviceKey,
  wordingFor,
} from "../../supabase/functions/_shared/cs-ask-policy";

// Source patterns taken from the delivered-lead export, never its composed
// messages. No real customer names, addresses or phone numbers are committed.
const read = (...sources: string[]) => ({
  detection: detect(sources),
  sources: normalizeSource(sources.join("\n")),
});
const ask = (service: string | null, ...sources: string[]) => {
  const { detection, sources: text } = read(...sources);
  return selectAsks(detection, service, detection.objects[0] ?? null, text);
};
const intents = (selection: { asks: { intent: AskIntent }[] }) =>
  selection.asks.map((entry) => entry.intent);

describe("catalogue integrity", () => {
  it("was generated from the full export and carries every layer", () => {
    expect(CS_ASK_CATALOGUE.meta.rows).toBeGreaterThan(20_000);
    expect(Object.keys(CS_ASK_CATALOGUE.ladders).length).toBeGreaterThan(200);
    expect(CS_ASK_CATALOGUE.pairs.length).toBeGreaterThan(8);
    expect(Object.keys(CS_ASK_CATALOGUE.wording).length).toBeGreaterThan(150);
    expect(CS_ASK_CATALOGUE.ladders["*"]).toBeDefined();
    // The no-object profile must stay its own bucket: the team falls back to
    // scope and address there, which the all-rows average washes out.
    expect(CS_ASK_CATALOGUE.ladders.none).toBeDefined();
  });

  it("every object pattern compiles and has both labels", () => {
    for (const [name, pattern] of CS_ASK_CATALOGUE.objectPatterns) {
      expect(() => new RegExp(pattern, "i")).not.toThrow();
      const labels = CS_ASK_CATALOGUE.objectLabels[name];
      expect(labels, name).toBeDefined();
      expect(labels[0].length, name).toBeGreaterThan(1);
      expect(labels[1].length, name).toBeGreaterThan(1);
    }
    for (const pattern of [
      ...CS_ASK_CATALOGUE.actionPatterns.map(([, source]) => source),
      ...Object.values(CS_ASK_CATALOGUE.factPatterns),
      CS_ASK_CATALOGUE.photoNegation,
    ]) {
      expect(() => new RegExp(pattern, "i")).not.toThrow();
    }
  });

  it("every catalogue phrase renders safely for its own object", () => {
    for (const [key] of Object.entries(CS_ASK_CATALOGUE.wording)) {
      const [intent, object] = key.split("|") as [AskIntent, string];
      const phrase = wordingFor(intent, object);
      // OWNERSHIP/QUANTITY/SIZE are object-bound, so a generic lookup is null,
      // but an object-keyed one must always produce a usable phrase.
      expect(phrase, key).toBeTruthy();
      expect(phrase, key).not.toMatch(/[{}]/);
      expect(phrase, key).not.toMatch(/\s{2,}/);
      expect(phrase, key).not.toMatch(/\b(?:a|an|the) (?:a|an|the)\b/i);
      expect(fragmentsAreSafe([{ intent, object, fragment: phrase! }]), key).toBe(true);
    }
  });

  it("ladders only reference known intents and plausible rates", () => {
    for (const [key, ladder] of Object.entries(CS_ASK_CATALOGUE.ladders)) {
      expect(ladder.n, key).toBeGreaterThanOrEqual(CS_ASK_CATALOGUE.meta.minRows);
      for (const entry of ladder.entries) {
        expect(ASK_INTENTS, `${key} ${entry.intent}`).toContain(entry.intent);
        expect(entry.askIfMissing).toBeGreaterThanOrEqual(CS_ASK_CATALOGUE.meta.minRate);
        expect(entry.askIfMissing).toBeLessThanOrEqual(1);
      }
    }
  });

  it("records which facts the delivered data would NOT have suppressed", () => {
    // These four measured ~1.0x or inverted suppression in the export, so the
    // runtime overrides the data rather than inheriting the habit. If this
    // list changes, the override stopped being deliberate.
    expect([...HARD_GUARDS].sort()).toEqual(["AVAILABILITY", "OWNERSHIP", "PHOTO", "STORIES"]);
  });

  it("keeps address terminal and never repeats an intent, in every pair list", () => {
    const lists = [CS_ASK_CATALOGUE.pairs, ...Object.values(CS_ASK_CATALOGUE.pairsByKey)];
    for (const list of lists) {
      for (const pair of list) {
        expect(pair.slot1).not.toBe(pair.slot2);
        // 0.5% of delivered messages did lead with the address; the generator
        // drops them so an address always closes a message.
        expect(pair.slot1).not.toBe("ADDRESS");
      }
    }
  });

  it("measures pairs per sub-category, ordered most-used first", () => {
    expect(Object.keys(CS_ASK_CATALOGUE.pairsByKey).length).toBeGreaterThan(200);
    for (const [key, list] of Object.entries(CS_ASK_CATALOGUE.pairsByKey)) {
      const shares = list.map((pair) => pair.share);
      expect(
        [...shares].sort((a, b) => b - a),
        key,
      ).toEqual(shares);
    }
  });
});

describe("reading what the customer already said", () => {
  it.each([
    ["street address in the post", "Repair at 123 Example Street, Denver CO", "ADDRESS"],
    ["address on file note", "Need repair. Address on file", "ADDRESS"],
    ["timing", "Need a handyman tomorrow after 3pm", "AVAILABILITY"],
    ["symptom", "My dishwasher is not working", "PROBLEM"],
    ["dimensions", "Need an 11x12 room painted", "SIZE"],
    ["quantity", "Need 12 windows cleaned", "QUANTITY"],
    ["ownership", "I already have the lights", "OWNERSHIP"],
    ["storeys", "Gutters on my two story house", "STORIES"],
    ["supplied photo", "Small drywall repair (picture below)", "PHOTO"],
  ])("detects %s", (_label, postText, fact) => {
    expect(detect([postText]).facts[fact]).toBe(true);
  });

  it.each([
    ["a ZIP code", "Job in 78738"],
    ["a room size", "an 11x12 room"],
    ["a model number", "LG model 12345"],
    ["a city only", "Denver, CO"],
  ])("does not mistake %s for a street address", (_label, postText) => {
    expect(detect([postText]).facts.ADDRESS).toBe(false);
  });

  it.each(["No photos attached", "I have not sent photos", "I haven't sent pictures yet"])(
    "does not treat negated photo evidence as supplied: %s",
    (postText) => {
      expect(detect([postText]).facts.PHOTO).toBe(false);
    },
  );

  it("masks object spans so a compound object is not also its generic parent", () => {
    expect(detect(["My garage door is off track"]).objects).toEqual(["garage_door"]);
    expect(detect(["Dryer vent needs cleaning"]).objects).toEqual(["dryer_vent"]);
    expect(detect(["Water heater is leaking"]).objects).toContain("water_heater");
    expect(detect(["Water heater is leaking"]).objects).not.toContain("furnace_heater");
  });

  it("does not let an appliance name supply its own verb", () => {
    // "washing machine" must not read as a cleaning job.
    expect(detect(["My washing machine is not working"]).action).toBe("repair");
    expect(detect(["Need my carpets cleaned"]).action).toBe("clean");
  });

  it("still finds the verb when the object pattern swallowed it", () => {
    // furniture_move matches "move", so masking removes the only verb.
    const detection = detect(["Need to move a hot tub about 50 feet to the backyard"]);
    expect(detection.action).toBe("move");
    expect(detection.sameSite).toBe(true);
  });

  it("scopes a known brand to the appliance it was written against", () => {
    const sources = normalizeSource("My Whirlpool freezer has frost and the stove is dead");
    expect(brandKnownFor("refrigerator", sources)).toBe(true);
    // An LG fridge in the same post must never mark the stove's brand known.
    expect(brandKnownFor("oven_stove", sources)).toBe(false);
  });

  it("never reads an outgoing draft or suggested question as a customer answer", () => {
    // sourceParts excludes them, so a draft naming an address and a photo
    // leaves both facts unknown.
    const detection = detect(["Need a fridge looked at"]);
    expect(detection.facts.ADDRESS).toBe(false);
    expect(detection.facts.PHOTO).toBe(false);
  });
});

describe("suppression: a supplied fact is never asked for again", () => {
  it.each([
    ["address", "Plumber needed at 418 Example Drive, Mesquite", "plumber", "ADDRESS"],
    ["timing", "Need a handyman tomorrow after 3pm", "handyman", "AVAILABILITY"],
    ["symptom", "My refrigerator is not cooling", "Appliance Repair", "PROBLEM"],
    ["dimensions", "Need my 11x12 carpet cleaned", "Carpet Cleaning Service", "SIZE"],
    ["quantity", "Need 12 windows cleaned", "Window Cleaning", "QUANTITY"],
    ["storeys", "Gutters cleaned on my two story house", "Gutter Cleaning", "STORIES"],
    ["supplied photo", "Drywall repair needed (picture below)", "handyman", "PHOTO"],
  ])("does not ask for %s", (_label, postText, service, fact) => {
    expect(intents(ask(service, postText))).not.toContain(fact);
  });

  it("does not ask the brand of the appliance the customer already named", () => {
    const selection = ask("Appliance Repair", "My Whirlpool freezer drawer won't close");
    expect(intents(selection)).not.toContain("BRAND/MODEL");
    expect(selection.suppressed).toContain("BRAND/MODEL");
  });

  it("still asks the brand when none was given", () => {
    expect(intents(ask("Refrigerator Repair", "Anyone able to look at my fridge?"))).toContain(
      "BRAND/MODEL",
    );
  });

  it("overrides the data for facts the team itself kept re-asking", () => {
    for (const intent of HARD_GUARDS) {
      const detection = detect(["placeholder"]);
      detection.facts[intent] = true;
      expect(isAnswered(intent, detection, null, "placeholder"), intent).toBe(true);
    }
  });

  it("never treats scope as answered, so a bare post always has a fallback ask", () => {
    const detection = detect(["Looking for a handyman"]);
    expect(isAnswered("SCOPE", detection, null, "looking for a handyman")).toBe(false);
  });
});

describe("sub-category ladders decide the lead ask", () => {
  it("resolves most specific first and degrades one level at a time", () => {
    expect(resolveLadder("refrigerator", "repair", "Appliance Repair").key).toBe(
      "refrigerator|repair",
    );
    expect(resolveLadder("refrigerator", "polish", "Appliance Repair").key).toBe("refrigerator");
    expect(resolveLadder(null, null, "plumber").key).toBe("svc:plumber");
    expect(resolveLadder(null, null, "no such trade at all").key).toBe("none");
  });

  it("asks a gutter job about storeys, which no category-level profile contains", () => {
    expect(intents(ask("Gutter Cleaning", "Looking for someone to clean my gutters"))).toContain(
      "STORIES",
    );
  });

  it("leads an appliance repair with brand, not with a photo", () => {
    expect(intents(ask("Refrigerator Repair", "Need someone to fix my fridge"))[0]).toBe(
      "BRAND/MODEL",
    );
  });

  it("sends a carpet clean the pair the team sends 77% of the time", () => {
    // SIZE -> PHOTO occurs 154 times in carpet|clean, against 26 for
    // PHOTO -> ADDRESS: a carpet clean asks the size first and rarely wants
    // an address at all.
    const selection = ask("Carpet Cleaning Service", "Need my carpet cleaned");
    expect(intents(selection)).toEqual(["SIZE", "PHOTO"]);
    // Fragments keep their verb; the repeated-verb elision happens at render.
    expect(selection.asks[1].fragment).toBe("share a picture of the carpet area");
  });

  it("asks a window clean for the detail that sub-category leads with", () => {
    // window|clean's own joint distribution leads with the window count, not
    // photos, even though photos are its more frequent single ask (84% vs
    // 50%). The window ladder one level up leads with size instead - which is
    // the replace/install behaviour, and why the action level matters.
    expect(intents(ask("Window Cleaning", "Can someone clean my windows?"))).toEqual([
      "QUANTITY",
      "PHOTO",
    ]);
  });

  it("drops the quantity ask once the customer has given a count", () => {
    const selection = ask("Window Cleaning", "Can someone clean my 12 windows?");
    expect(intents(selection)).not.toContain("QUANTITY");
    expect(selection.suppressed).toContain("QUANTITY");
  });

  it("treats a move as a move, not as a repair of the thing being moved", () => {
    const selection = ask("Moving Service", "Need to move a hot tub about 50 feet to the backyard");
    expect(selection.ladderKey).toBe("furniture_move|move");
    expect(intents(selection)).not.toContain("PROBLEM");
  });

  it("does not request a drop-off address for a move inside one property", () => {
    const selection = ask("Moving Service", "Move the hot tub 50 feet to the backyard");
    expect(selection.asks.map((entry) => entry.fragment).join(" ")).not.toMatch(/pick.?up/i);
  });

  it("does ask for the route on a real move between places", () => {
    const selection = ask("Moving Help", "Need movers for a sofa and mattress to our new place");
    expect(selection.asks.map((entry) => entry.fragment).join(" ")).toMatch(
      /pickup and drop off addresses/i,
    );
  });

  it("falls back to scope and address when no object can be identified", () => {
    const ladder = CS_ASK_CATALOGUE.ladders.none.entries.map((entry) => entry.intent);
    expect(ladder).toContain("SCOPE");
    expect(ladder).toContain("ADDRESS");
  });
});

describe("a phrase is never borrowed from a different kind of job", () => {
  it("asks an assembly job about assembling, not moving", () => {
    // 395 assembly rows: the team asked for a photo of the items "that need to
    // be assembled" plus a plain address. Only 26 of them (6.6%) ever
    // mentioned a pickup route, and furniture_move's pattern was swallowing
    // the word "furniture" and sending them the moving ask.
    const selection = ask("Furniture Assembly", "Looking for someone to assemble a bed frame");
    expect(selection.ladderKey).toMatch(/^furniture_assembly/);
    const text = selection.asks.map((entry) => entry.fragment).join(" and ");
    expect(text).toMatch(/assembled/);
    expect(text).not.toMatch(/moved|pick.?up/i);
  });

  it("still asks a real move for the route", () => {
    const text = ask("Moving Help", "Need movers for a sofa, moving to our new place")
      .asks.map((entry) => entry.fragment)
      .join(" and ");
    expect(text).toMatch(/moved/);
    expect(text).toMatch(/pickup and drop off addresses/);
  });

  it("treats a roof leak as a roof job, not plumbing", () => {
    // 96 rows said "roof" but pipe_leak's \bleak\w* claimed them first. The
    // team asked those about storeys and the address.
    const selection = ask("Roof Leak Repair", "I have a roof leak over the kitchen");
    expect(selection.ladderKey).toMatch(/^roof/);
    expect(intents(selection)).toContain("STORIES");
  });

  it("does not ask a sofa being cleaned about items that need to be moved", () => {
    // furniture_move|clean is upholstery cleaning. No action-scoped phrase
    // reached the threshold here, so the guard has to reject the object-level
    // phrase rather than send a contradiction.
    const text = ask("Carpet Cleaning Service", "Need my sofa and couch cleaned")
      .asks.map((entry) => entry.fragment)
      .join(" and ");
    expect(text).not.toMatch(/moved|pick.?up/i);
  });

  it("rejects any phrase naming an action other than this job's", () => {
    expect(contradictsAction("share pictures of the items that need to be moved", "clean")).toBe(
      true,
    );
    expect(contradictsAction("share pictures of the items that need to be moved", "move")).toBe(
      false,
    );
    // Action-neutral phrasing is always allowed.
    expect(contradictsAction("share your complete address", "clean")).toBe(false);
    expect(contradictsAction("share some pictures", "move")).toBe(false);
    // No detected action means nothing to contradict.
    expect(contradictsAction("items that need to be moved", null)).toBe(false);
  });

  it("prefers the phrase measured for this object doing this job", () => {
    expect(wordingFor("PHOTO", "furniture_move", "move")).toMatch(/moved/);
    expect(wordingFor("PHOTO", "furniture_assembly", "install")).toMatch(/assembled/);
  });
});

describe("the stated brand and the named object are read correctly", () => {
  it("does not re-ask the brand when no object pattern matched the phrasing", () => {
    // "GE Front load wash Machine" matched no object, so the brand could not
    // be scoped to one and was asked for again. With no object there is no
    // second appliance to confuse it with.
    const selection = ask(
      "Appliance Repair",
      "I am looking for somebody to fix my GE Front load wash Machine",
    );
    expect(intents(selection)).not.toContain("BRAND/MODEL");
    expect(selection.suppressed).toContain("BRAND/MODEL");
  });

  it("reads 'wash machine' as a washing machine", () => {
    expect(detect(["fix my front load wash machine"]).objects).toContain("washer");
  });

  it("still asks the brand when the customer never gave one", () => {
    expect(
      intents(ask("Appliance Repair", "I need someone who can fix my refrigerator")),
    ).toContain("BRAND/MODEL");
  });

  it("does not call a patio screen repair a deck", () => {
    // deck's \bpatios?\b was claiming these, so the team's own "the screen
    // enclosure" / "the patio screening" wording became "the deck".
    const selection = ask("Patio screens repair", "Patio screens repair");
    expect(selection.ladderKey).toMatch(/^screen/);
    expect(selection.asks.map((entry) => entry.fragment).join(" ")).not.toMatch(/deck/i);
  });

  it("leaves screen doors and window screens with their own wording", () => {
    // A screen door is still a door, and window screens are still windows:
    // the screen object sits after both so it only claims what they leave.
    expect(detect(["my screen door is torn"]).objects[0]).toBe("door");
    expect(detect(["need my window screens cleaned"]).objects[0]).toBe("window");
  });
});

describe("the message uses the customer's own word for the thing", () => {
  it.each([
    ["porch", "Porch Repair", "take out and put in three 10 foot porch boards", /porch/, /deck/],
    ["concrete slab", "Concrete Repair", "pouring a 10x10 concrete slab", /concrete/, /driveway/],
    ["french drain", "General Plumbing Repair", "install a French drain", /drain/, /\bsink\b/],
    ["fridge", "Appliance Repair", "need my fridge looked at", /fridge/, /refrigerator/],
  ])("calls a %s what the customer called it", (_label, service, post, expected, forbidden) => {
    const text = ask(service, post)
      .asks.map((entry) => entry.fragment)
      .join(" and ");
    expect(text).toMatch(expected);
    expect(text).not.toMatch(forbidden);
  });

  it("keeps the catalogue's own label when the customer used it", () => {
    // Substitution only fires when our label is absent, so attested wording
    // is untouched everywhere else.
    expect(
      ask("Deck Repair", "my deck boards are rotting")
        .asks.map((a) => a.fragment)
        .join(" "),
    ).toMatch(/deck/);
  });

  it("never emits a truncated stem or a qualifier as the noun", () => {
    for (const [object, nouns] of Object.entries(CS_ASK_CATALOGUE.objectNouns)) {
      for (const noun of nouns) {
        expect(noun, `${object}: ${noun}`).toMatch(/^[a-z][a-z ]{2,}$/);
      }
    }
    // Regressions that reached a customer before this guard existed.
    expect(CS_ASK_CATALOGUE.objectNouns.furniture_move).not.toContain("mov");
    expect(CS_ASK_CATALOGUE.objectNouns.junk).not.toContain("house");
  });

  it("does not read a plumbing clean-out as a junk clearance", () => {
    const selection = ask("plumber", "Need plumber for an external clean out going to the house");
    expect(selection.asks.map((entry) => entry.fragment).join(" ")).not.toMatch(/junk/i);
  });

  it("still reads an estate cleanout as a clearance", () => {
    expect(ask("Junk Removal", "Need an estate cleanout, lots of furniture").ladderKey).toMatch(
      /^junk/,
    );
  });

  it("ties a brand to its appliance in either word order", () => {
    // "fixes fridges lg model" names the object before the brand.
    expect(
      brandKnownFor("refrigerator", normalizeSource("someone who fixes fridges lg model")),
    ).toBe(true);
    expect(brandKnownFor("refrigerator", normalizeSource("lg french door refrigerator"))).toBe(
      true,
    );
    // A conjunction still means a second appliance has started.
    expect(brandKnownFor("oven_stove", normalizeSource("lg refrigerator and a stove"))).toBe(false);
  });
});

describe("the selected pair is always one the team actually sends", () => {
  const cases: [string, string][] = [
    ["Appliance Repair", "My fridge stopped working"],
    ["Carpet Cleaning Service", "Need carpets cleaned"],
    ["Gutter Cleaning", "Gutters need clearing"],
    ["handyman", "Need a few small repairs done"],
    ["plumber", "Kitchen sink is clogged"],
    ["Moving Help", "Need help moving a sofa"],
    ["Window Cleaning", "Windows need washing"],
    ["Interior Painting", "Want my bedroom painted"],
    ["Garage Door Repair", "Garage door is off track"],
    ["General Pest Control", "I think we have roaches"],
    ["HVAC", "AC is not cooling"],
    ["Junk Removal", "Need junk hauled away"],
  ];

  it.each(cases)("%s / %s", (service, postText) => {
    const selection = ask(service, postText);
    expect(selection.asks.length).toBeGreaterThan(0);
    expect(selection.asks.length).toBeLessThanOrEqual(2);
    expect(fragmentsAreSafe(selection.asks)).toBe(true);
    const keys = intents(selection);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).not.toBe("ADDRESS");
    if (keys.length === 2) {
      expect(
        CS_ASK_CATALOGUE.pairs.some((pair) => pair.slot1 === keys[0] && pair.slot2 === keys[1]),
        keys.join(" + "),
      ).toBe(true);
    } else {
      expect(CS_ASK_CATALOGUE.solo[keys[0]], keys[0]).toBeDefined();
    }
  });

  it("asks at most two things however little the customer said", () => {
    expect(ask("handyman", "help").asks.length).toBeLessThanOrEqual(2);
  });

  it("uses two real missing details without resurrecting known stories or address", () => {
    const selection = ask(
      "Gutter Cleaning",
      "Clean the gutters on my two story house at 123 Example Street",
    );
    expect(selection.asks.map((item) => item.intent)).toEqual(
      expect.arrayContaining(["PHOTO", "SIZE"]),
    );
    expect(selection.asks).toHaveLength(2);
    expect(selection.suppressed).toContain("STORIES");
    expect(selection.suppressed).toContain("ADDRESS");
  });
});

describe("helpers", () => {
  it("normalises a service into a catalogue key", () => {
    // "repair" only drops as part of "repair service", matching the generator's
    // service_key() exactly - the catalogue is keyed on these strings.
    expect(serviceKey("General Plumbing Repair")).toBe("plumbing repair");
    expect(serviceKey("General Handyman Service")).toBe("handyman");
    expect(serviceKey("HANDYMAN")).toBe("handyman");
    expect(serviceKey(null)).toBe("");
  });

  it("refuses to emit an object-bound ask without object wording", () => {
    expect(wordingFor("OWNERSHIP", null)).toBeNull();
    expect(wordingFor("QUANTITY", null)).toBeNull();
    expect(wordingFor("SIZE", null)).toBeNull();
    expect(wordingFor("ADDRESS", null)).toBe("share your complete address");
  });
});
