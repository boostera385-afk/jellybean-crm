import { describe, expect, it, vi } from "vitest";
import { CS_CONTEXT_VOCABULARY } from "../../supabase/functions/_shared/cs-context-vocabulary.generated";
import {
  fallbackServiceContext,
  namesObject,
  refersToObject,
  stem,
  tokens,
  ungroundedWords,
} from "../../supabase/functions/_shared/cs-context-grounding";
import {
  CS_COMPOSER_PROMPT,
  composeAnswerAware,
  groundingParts,
  safeComposerError,
  type ComposerInput,
} from "../../supabase/functions/_shared/cs-composer";

/**
 * The "I saw that you are looking for ___." phrase is the one part of a reply
 * the model writes, so it is checked against the data: every word is in the
 * lead or is the team's own, and it names the item the questions ask about.
 * Lead texts are generic; none is a customer's actual post.
 */

const reply = (serviceContext: string, targetObject = "none") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify({ serviceContext, targetObject }) },
        },
      ],
    }),
    { status: 200 },
  );
/** A model that answers each call in turn, with a fresh body every time. */
const model = (...answers: string[]) => {
  let call = 0;
  return vi.fn(async () => reply(answers[Math.min(call++, answers.length - 1)]));
};
const sentBody = (fetcher: ReturnType<typeof model>, call: number) =>
  JSON.parse(
    JSON.parse((fetcher.mock.calls[call] as unknown as [string, { body: string }])[1].body)
      .messages[1].content,
  );
const lead = (input: Partial<ComposerInput>): ComposerInput => ({
  customerName: "Casey Test",
  ...input,
});

describe("words match the generator that built the vocabulary", () => {
  it("stems exactly as scripts/build-context-vocabulary.py does", () => {
    // Computed by the Python generator and written into the generated file;
    // any drift here would make the check disagree with how it was measured.
    for (const [word, expected] of CS_CONTEXT_VOCABULARY.stemProbes)
      expect(stem(word)).toBe(expected);
  });

  it("tokenises the same way", () => {
    expect(tokens("Hi, I need a 2-car garage door FIXED!")).toEqual([
      "hi",
      "i",
      "need",
      "a",
      "2",
      "car",
      "garage",
      "door",
      "fixed",
    ]);
  });

  it("was measured on held-out phrases and accepts nearly all of the team's own", () => {
    expect(CS_CONTEXT_VOCABULARY.meta.heldOutAcceptance).toBeGreaterThan(0.9);
    expect(CS_CONTEXT_VOCABULARY.meta.phrases).toBeGreaterThan(20_000);
  });
});

describe("every word comes from the lead or from the team", () => {
  const leadText = ["My garage door is off track and makes a grinding noise"];

  it("accepts a phrase built the team's way", () => {
    expect(ungroundedWords("a garage door repair service", leadText)).toEqual([]);
    expect(ungroundedWords("a professional to fix your garage door", leadText)).toEqual([]);
  });

  it("refuses a brand, a number or a detail the lead never gave", () => {
    expect(ungroundedWords("a Chamberlain garage door repair service", leadText)).toEqual([
      "chamberlain",
    ]);
    expect(ungroundedWords("a 16 foot garage door repair service", leadText)).toContain("16");
    expect(ungroundedWords("an emergency garage door repair service", leadText)).toEqual([
      "emergency",
    ]);
  });

  it("lets a number through when the lead gives it, in either spelling", () => {
    expect(ungroundedWords("a repair for two doors", ["need 2 doors fixed"])).toEqual([]);
    expect(ungroundedWords("a repair for 2 doors", ["need two doors fixed"])).toEqual([]);
  });

  it("keeps facts out of the team vocabulary, so they must come from the lead", () => {
    const vocabulary = new Set<string>(CS_CONTEXT_VOCABULARY.stems);
    for (const fact of ["50", "30", "two", "kitchenaid", "hanydman", "techinician"])
      expect(vocabulary.has(stem(fact))).toBe(false);
  });

  it("reads the lead's own fields but never our previous draft", () => {
    const parts = groundingParts(
      lead({
        postText: "Fridge not cooling",
        service: "Appliance Repair",
        suggestedRequirements: ["brand name"],
        previousDraft: "Hi Casey, I saw that you are looking for a Sub-Zero repair",
      }),
    );
    expect(parts).toContain("Appliance Repair");
    expect(parts.join(" ")).not.toMatch(/sub-zero/i);
  });
});

describe("the opening names what the questions ask about", () => {
  it("knows 'the unit' leans on the opening to say which unit", () => {
    expect(refersToObject(["let me know how big the unit is"], "ac_unit")).toBe(true);
    expect(refersToObject(["share your complete address"], "ac_unit")).toBe(false);
  });

  it("finds the item in the phrase by the same pattern detection uses", () => {
    expect(namesObject("an electrician for home electrical work and AC repair", "ac_unit")).toBe(
      true,
    );
    expect(namesObject("an electrician", "ac_unit")).toBe(false);
    expect(namesObject("anything at all", null)).toBe(true);
  });
});

describe("the fallback phrase is the team's commonest shape", () => {
  it.each([
    ["Gutter Cleaning", "a gutter cleaning service"],
    ["Moving Service", "a moving service"],
    ["General Handyman Service", "a general handyman service"],
    ["Appliance Repair", "an appliance repair service"],
    ["Electrician", "an electrician"],
    ["HVAC", "an HVAC service"],
  ])("%s -> %s, grounded by construction", (service, expected) => {
    expect(fallbackServiceContext(service)).toBe(expected);
    expect(ungroundedWords(expected, [service])).toEqual([]);
  });

  it("gives nothing for a lead without a service, rather than inventing one", () => {
    expect(fallbackServiceContext("")).toBeNull();
    expect(fallbackServiceContext(null)).toBeNull();
  });
});

describe("composing with the checks", () => {
  const garage = lead({
    postText: "My garage door is off track and makes a grinding noise",
    service: "Garage Door Repair",
  });

  it("takes a grounded first answer as it is, in one call", async () => {
    const fetcher = model("a garage door repair service");
    const result = await composeAnswerAware(garage, { apiKey: "k", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.plan.serviceContext).toBe("a garage door repair service");
    expect(result.warnings).not.toContain("context_retried");
  });

  it("asks once more, naming the invented word, and uses the fixed answer", async () => {
    const fetcher = model(
      "an emergency garage door repair service",
      "a garage door repair service",
    );
    const result = await composeAnswerAware(garage, { apiKey: "k", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sentBody(fetcher, 0)).not.toHaveProperty("correction");
    expect(sentBody(fetcher, 1).correction.join(" ")).toContain("emergency");
    expect(result.plan.serviceContext).toBe("a garage door repair service");
    expect(result.warnings).toContain("context_retried");
    expect(result.warnings).not.toContain("context_fallback");
  });

  it("falls back to the lead's own service when the retry invents too", async () => {
    const fetcher = model("an emergency garage door repair service");
    const result = await composeAnswerAware(garage, { apiKey: "k", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.plan.serviceContext).toBe("a garage door repair service");
    expect(result.warnings).toEqual(
      expect.arrayContaining(["context_retried", "context_fallback"]),
    );
  });

  it("composes nothing when it can neither ground the phrase nor fall back", async () => {
    const fetcher = model("an emergency garage door repair service");
    const failure = await composeAnswerAware(
      { ...garage, service: null },
      { apiKey: "k", fetcher },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // The edge function shows this code; the agent's draft is left untouched.
    expect(safeComposerError(failure)).toBe("Composer could not ground the service context");
  });

  describe("an opening that names one job and questions about another", () => {
    const both = lead({
      postText: "I need an electrician for some work in my home who can also repair my AC",
      service: "Electrician",
    });
    const fragments = (result: Awaited<ReturnType<typeof composeAnswerAware>>) =>
      result.plan.questions.map((question) => question.text).join(" | ");

    it("keeps the AC question once the retry names the AC", async () => {
      const fetcher = model(
        "an electrician",
        "an electrician for home electrical work and AC repair",
      );
      const result = await composeAnswerAware(both, { apiKey: "k", fetcher });
      expect(sentBody(fetcher, 1).correction.join(" ")).toMatch(/must name it/);
      expect(fragments(result)).toContain("how big the unit is");
      expect(result.warnings).not.toContain("object_questions_dropped");
    });

    it("drops 'how big the unit is' rather than ask it after an opening that never named it", async () => {
      const fetcher = model("an electrician");
      const result = await composeAnswerAware(both, { apiKey: "k", fetcher });
      expect(result.plan.serviceContext).toBe("an electrician");
      expect(fragments(result)).not.toMatch(/the unit/);
      expect(result.plan.targetObject).toBeNull();
      expect(result.warnings).toContain("object_questions_dropped");
    });
  });
});

describe("the prompt states the rule the code enforces", () => {
  it("lists the team's own words, generated from the data", () => {
    expect(CS_COMPOSER_PROMPT).toContain(CS_CONTEXT_VOCABULARY.promptWords.slice(0, 5).join(", "));
    expect(CS_COMPOSER_PROMPT).toMatch(/must name the item you give as targetObject/);
    expect(CS_COMPOSER_PROMPT).toMatch(/Never add a number, brand, place/);
  });
});
