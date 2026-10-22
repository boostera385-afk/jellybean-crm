import { describe, expect, it } from "vitest";
import { CS_ASK_CATALOGUE } from "../../supabase/functions/_shared/cs-ask-catalogue.generated";
import type { AskIntent } from "../../supabase/functions/_shared/cs-ask-catalogue-types";
import { detect, normalizeSource } from "../../supabase/functions/_shared/cs-detect";
import { labelFor, selectAsks } from "../../supabase/functions/_shared/cs-ask-policy";

/**
 * Wording defects found by reading a day of real composed drafts, then counted
 * across all 27,552 delivered leads. Each lead text below reproduces one in
 * generic words; none is a customer's actual post.
 *
 *   "the size of the paint that needs to be painted"   2,242 leads before
 *   the brand asked right after the draft named it          86
 *   a fridge moved between houses, asked for one address    168
 */

const ask = (service: string | null, ...sources: string[]) => {
  const detection = detect(sources);
  return selectAsks(
    detection,
    service,
    detection.objects[0] ?? null,
    normalizeSource(sources.join("\n")),
  );
};
const fragments = (selection: { asks: { fragment: string }[] }) =>
  selection.asks.map((entry) => entry.fragment).join(" | ");
const intents = (selection: { asks: { intent: AskIntent }[] }) =>
  selection.asks.map((entry) => entry.intent);

describe("the customer's word replaces ours only where the team uses it", () => {
  it("never puts a word for the job where the thing being worked on goes", () => {
    // These come from object patterns, where they recognise the JOB. The team
    // never writes "a picture of the paint", so none may stand in for the
    // label - they were how drafts came to ask for "the size of the paint".
    const jobWords = [
      "paint",
      "pressure wash",
      "power wash",
      "soft wash",
      "assembl",
      "put together",
      "haul",
      "remodel",
      "renovat",
    ];
    const nouns = Object.values(CS_ASK_CATALOGUE.objectNouns).flat();
    for (const word of jobWords) expect(nouns).not.toContain(word);
  });

  it("asks a painting job about the area, never about 'the paint'", () => {
    const text = fragments(ask("Exterior House Painting", "Exterior house painters needed soon"));
    expect(text).toContain("the area that needs to be painted");
    expect(text).not.toMatch(/\bthe paints?\b/);
  });

  it("matches whole words, so 'painters' is not the noun 'paint'", () => {
    expect(labelFor("paint", "exterior house painters needed", false)).toBe("area");
  });

  it.each([
    ["refrigerator", "my fridge is not cooling", "fridge"],
    ["hot_tub", "my spa will not heat", "spa"],
    ["deck", "repair the boards on my porch", "porch"],
    ["oven_stove", "the stove burner will not light", "stove"],
  ])("keeps the customer's %s word when the team writes it there too", (object, text, word) => {
    expect(labelFor(object, text, false)).toBe(word);
  });

  it("uses the team's own plural, or the label's, never an invented one", () => {
    // The team writes "couches"; it never writes "furnitures" or "vanitys".
    expect(labelFor("furniture_move", "move a couch and a chair", true)).toBe("couches");
    const furniture = labelFor("furniture_move", "move some furniture", true);
    expect(furniture).toBe(CS_ASK_CATALOGUE.objectLabels.furniture_move[1]);
    expect(furniture).not.toBe("furnitures");
    expect(labelFor("cabinet", "install a new vanity", true)).not.toBe("vanitys");
  });
});

describe("brands are found in the data, not typed by hand", () => {
  const brand = new RegExp(CS_ASK_CATALOGUE.factPatterns["BRAND/MODEL"], "i");

  it.each(["thermador", "kitchenaid", "sub-zero", "viking", "amana", "electrolux"])(
    "recognises %s, which the old hand-typed list missed",
    (name) => {
      expect(brand.test(`repair my ${name} refrigerator`)).toBe(true);
    },
  );

  it.each(["houston", "miami", "marietta", "dallas", "christmas", "french", "saturday"])(
    "does not mistake %s for a brand, though people capitalise it too",
    (word) => {
      expect(brand.test(word)).toBe(false);
    },
  );

  it("does not ask for the brand the customer has just given", () => {
    const selection = ask("Appliance Repair", "Need a repair person for my Thermador freezer");
    expect(intents(selection)).not.toContain("BRAND/MODEL");
  });
});

describe("a move asks for the route whatever is being moved", () => {
  it("asks for both addresses when an appliance moves between houses", () => {
    // The team asks a move for both ends in 66% of 458 delivered moves; the
    // fridge's own address question is the wrong one for this job.
    const selection = ask(
      "Moving Service",
      "Need someone to move a refrigerator from one house to another",
    );
    expect(fragments(selection)).toMatch(/pickup and drop off addresses/i);
  });

  it("still asks one address for a move inside one property", () => {
    const selection = ask("Moving Service", "Move the hot tub 50 feet to the backyard");
    expect(fragments(selection)).not.toMatch(/pick.?up/i);
  });
});
