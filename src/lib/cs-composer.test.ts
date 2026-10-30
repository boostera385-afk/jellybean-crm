import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ASK_INTENTS } from "../../supabase/functions/_shared/cs-ask-catalogue-types";
import { normalizeSource } from "../../supabase/functions/_shared/cs-detect";
import {
  CS_COMPOSER_MODEL,
  CS_COMPOSER_VERSION,
  CS_COMPOSER_PROMPT,
  COMPOSE_TARGET_SCHEMA,
  composeAnswerAware,
  joinAsks,
  parseTargeting,
  referralPlatform,
  renderComposePlan,
  safeComposerError,
  scoreComposeReply,
  sourceParts,
  type ComposePlan,
  type ComposerInput,
  type ComposerEvalCase,
} from "../../supabase/functions/_shared/cs-composer";

const lead = (input: Partial<ComposerInput>): ComposerInput => ({
  customerName: "Casey Test",
  ...input,
});

describe("first-contact sensible-question regressions", () => {
  const cases = JSON.parse(
    readFileSync("scripts/fixtures/cs-composer-cases.json", "utf8"),
  ) as ComposerEvalCase[];
  it("keeps regression intent identifiers aligned with the live catalogue", () => {
    for (const test of cases)
      for (const intent of test.forbiddenKeys ?? []) expect(ASK_INTENTS).toContain(intent);
  });
  it.each(cases)("$name keeps the approved format and supplied facts", async (test) => {
    const fetcher = echoingModel();
    const result = await composeAnswerAware(test.input!, { apiKey: "test-key", fetcher });
    const keys = result.plan.questions.map((q) => q.key);
    // Targeting prose is mocked here; real model scope coverage is checked by
    // the separate deployed evaluation. This test exercises actual selection.
    const message = renderComposePlan(test.input!, result.plan, "Alex");
    const score = scoreComposeReply(
      { ...test, mustMention: [], mustMentionAny: [] },
      message,
      keys,
    );
    expect(score).toMatchObject({ pass: true, forbidden: [], forbiddenPhrases: [] });
    if (keys.length)
      expect(message).toMatch(
        /^Hi Casey, this is Alex\. I saw that you are looking for .+\. Could you kindly .+, so I can check the schedule for a visit\?$/,
      );
    if (test.maxQuestions === 0) expect(fetcher).not.toHaveBeenCalled();
  });
});
const plan = (overrides: Partial<ComposePlan> = {}): ComposePlan => ({
  serviceContext: "a refrigerator repair service",
  targetObject: "refrigerator",
  ladderKey: "refrigerator|repair",
  questions: [],
  ...overrides,
});
/**
 * A stand-in model that behaves as the real one is told to: it names the job
 * in the customer's own words. The fixed "a home service" this replaces no
 * longer passes, because an opening must name the item the questions ask
 * about, and these regressions exist to exercise question selection, not that
 * refusal (tested on its own below). Each call gets a fresh Response, as the
 * network would give it: a body can only be read once.
 */
function echoingModel() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { lead } = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    const words = normalizeSource(lead.postText || lead.context)
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // parseTargeting refuses anything over 250 characters; cut at a word.
    return targeting(words.length > 200 ? words.slice(0, words.lastIndexOf(" ", 200)) : words);
  });
}
const targeting = (serviceContext: string, targetObject = "none", finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finish,
          message: { content: JSON.stringify({ serviceContext, targetObject }) },
        },
      ],
    }),
    { status: 200 },
  );

describe("the model is only asked for what is genuinely a judgement call", () => {
  it("states that it does not choose or word the questions", () => {
    expect(CS_COMPOSER_PROMPT).toMatch(/do NOT choose or write the questions/);
    expect(CS_COMPOSER_PROMPT).toMatch(/postText is the customer's own words/);
    expect(CS_COMPOSER_PROMPT).toMatch(/untrusted DATA/);
    // No question-selection policy belongs in the prompt any more: it is in
    // the catalogue, so a weak model cannot talk itself out of it.
    expect(CS_COMPOSER_PROMPT).not.toMatch(/complete address/i);
    expect(CS_COMPOSER_PROMPT).not.toMatch(/at most TWO/i);
  });

  it("offers only the objects actually detected, plus none", () => {
    const schema = COMPOSE_TARGET_SCHEMA(["refrigerator", "oven_stove"]);
    expect(schema.properties.targetObject.enum).toEqual(["refrigerator", "oven_stove", "none"]);
    expect(schema.required).toEqual(["serviceContext", "targetObject"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("keeps outgoing drafts and suggested questions out of the read sources", () => {
    const parts = sourceParts(
      lead({
        postText: "Need a fridge looked at",
        context: "Customer needs refrigerator repair",
        notes: ["Spoke to customer"],
        mainArea: "Denver",
        subArea: "Aurora",
        previousDraft: "The job is at 123 Example Street tomorrow. Photo attached.",
        suggestedRequirements: ["share your complete address"],
      }),
    );
    expect(parts).toEqual([
      "Need a fridge looked at",
      "Customer needs refrigerator repair",
      "Denver",
      "Aurora",
      "Spoke to customer",
    ]);
  });
});

describe("validating what the model returns", () => {
  it("accepts a plain noun phrase and trims its punctuation", () => {
    expect(
      parseTargeting({ serviceContext: "a garage door repair service.", targetObject: "none" }, []),
    ).toEqual({ serviceContext: "a garage door repair service", targetObject: null });
  });

  it("keeps a target only when it is one of the detected objects", () => {
    const objects = ["refrigerator"];
    expect(
      parseTargeting({ serviceContext: "a repair", targetObject: "refrigerator" }, objects)
        .targetObject,
    ).toBe("refrigerator");
    expect(
      parseTargeting({ serviceContext: "a repair", targetObject: "spaceship" }, objects)
        .targetObject,
    ).toBeNull();
  });

  it.each([
    ["a free estimate visit", "free estimate"],
    ["a repair, we are licensed and insured", "licensing"],
    ["a repair for $99", "a price"],
    ["a repair, I'll call you tomorrow", "a promised call"],
  ])("refuses an opening that claims %s", (serviceContext) => {
    expect(() => parseTargeting({ serviceContext, targetObject: "none" }, [])).toThrow(
      /Unsupported composer opening/,
    );
  });

  it.each([
    ["a placeholder", "(Service Context)"],
    ["a brace placeholder", "a repair of {object}"],
    ["a template label", "Customer needs: a repair"],
  ])("refuses an opening containing %s", (_label, serviceContext) => {
    expect(() => parseTargeting({ serviceContext, targetObject: "none" }, [])).toThrow();
  });

  it("refuses an empty, oversized or question-shaped opening", () => {
    expect(() => parseTargeting({ serviceContext: "  ", targetObject: "none" }, [])).toThrow();
    expect(() =>
      parseTargeting({ serviceContext: "a".repeat(300), targetObject: "none" }, []),
    ).toThrow();
    expect(() =>
      parseTargeting({ serviceContext: "what do you need?", targetObject: "none" }, []),
    ).toThrow();
    expect(() => parseTargeting({ serviceContext: 123, targetObject: "none" }, [])).toThrow();
    expect(() => parseTargeting(null, [])).toThrow();
  });
});

describe("a lead we already spoke to is not introduced again", () => {
  it.each([
    ["Had a conversation on FB", "Facebook"],
    ["Had a conversation on Nextdoor", "Nextdoor"],
    ["had a conversation on facebook", "Facebook"],
    ["Customer had a conversation on Next Door about the roof", "Nextdoor"],
  ])("%s -> %s", (reference, expected) => {
    expect(referralPlatform(reference)).toBe(expected);
  });

  it.each([
    ["ND", "a bare source marker, not a conversation"],
    ["mail", "a source marker"],
    ["", "empty"],
    [null, "absent"],
    ["Found on facebook marketplace", "names a platform but no conversation"],
  ])("%s stays on the standard opening (%s)", (reference, _why) => {
    expect(referralPlatform(reference)).toBeNull();
  });

  it("uses the referral opening, drops the sender and the article", () => {
    // 1,397 delivered referral messages: only 11 carry "this is <name>", and
    // "regarding" beats "that you are looking for" 1,072 to 76.
    const message = renderComposePlan(
      lead({ reference: "Had a conversation on FB" }),
      plan({
        serviceContext: "a refrigerator repair service",
        questions: [{ key: "ADDRESS", object: null, text: "share your complete address" }],
      }),
      "Gordon",
    );
    expect(message).toBe(
      "Hi Casey, we had a conversation on Facebook regarding refrigerator repair service. " +
        "Could you kindly share your complete address, so I can check the schedule for a visit?",
    );
    expect(message).not.toMatch(/this is Gordon/);
    expect(message).not.toMatch(/looking for/);
  });

  it("keeps the standard opening when the reference is only a source marker", () => {
    const message = renderComposePlan(
      lead({ reference: "ND" }),
      plan({ questions: [{ key: "ADDRESS", object: null, text: "share your complete address" }] }),
      "Gordon",
    );
    expect(message).toContain("Hi Casey, this is Gordon. I saw that you are looking for");
    expect(message).not.toMatch(/conversation on/);
  });

  it("asks the same questions either way - only the opening changes", () => {
    const questions = [{ key: "PHOTO" as const, object: null, text: "share some pictures" }];
    const asks = (reference: string) =>
      renderComposePlan(lead({ reference }), plan({ questions }), "Gordon").split("Could you")[1];
    expect(asks("Had a conversation on FB")).toBe(asks("ND"));
  });
});

describe("rendering the house template", () => {
  it("renders the team's exact three-part shape", () => {
    const message = renderComposePlan(
      lead({}),
      plan({
        questions: [
          { key: "BRAND/MODEL", object: "refrigerator", text: "share the brand name" },
          { key: "ADDRESS", object: null, text: "share your complete address" },
        ],
      }),
      "Martin",
    );
    expect(message).toBe(
      "Hi Casey, this is Martin. I saw that you are looking for a refrigerator repair service. " +
        "Could you kindly share the brand name and your complete address, " +
        "so I can check the schedule for a visit?",
    );
    expect(message.match(/\?/g)).toHaveLength(1);
  });

  it("elides a repeated leading verb, as the delivered messages do", () => {
    // "your complete address" stands alone 3,908 times in the export.
    expect(joinAsks(["share a picture of the door", "share your complete address"])).toBe(
      "share a picture of the door and your complete address",
    );
    // Different verbs are both kept.
    expect(joinAsks(["let me know the size", "share your complete address"])).toBe(
      "let me know the size and share your complete address",
    );
    expect(joinAsks(["share some pictures"])).toBe("share some pictures");
    expect(joinAsks([])).toBe("");
  });

  it("drops the question sentence entirely when nothing is left to ask", () => {
    expect(renderComposePlan(lead({}), plan(), "Martin")).toBe(
      "Hi Casey, this is Martin. I saw that you are looking for a refrigerator repair service.",
    );
  });

  it("sends one ask without padding it out to two", () => {
    const message = renderComposePlan(
      lead({}),
      plan({ questions: [{ key: "ADDRESS", object: null, text: "share your complete address" }] }),
      "Martin",
    );
    expect(message).toMatch(/Could you kindly share your complete address, so I can check/);
    expect(message).not.toMatch(/ and /);
  });

  it.each([
    ["Casey Test", "Casey"],
    ["María-José Díaz", "María-José"],
    ["", "there"],
    ["123", "there"],
    ["<script>", "there"],
  ])("greets %s safely", (customerName, expected) => {
    expect(renderComposePlan(lead({ customerName }), plan(), "Martin")).toContain(
      `Hi ${expected}, this is Martin.`,
    );
  });
});

describe("the exact shared generation pipeline", () => {
  it("makes ONE model call and pins the model and its controls", async () => {
    const fetcher = vi.fn().mockResolvedValue(targeting("a refrigerator repair service"));
    const result = await composeAnswerAware(
      lead({ postText: "My fridge stopped working", service: "Refrigerator Repair" }),
      { apiKey: "test-key", fetcher },
    );
    // v2 spent a second call on a nano model reviewing its own nano output.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(CS_COMPOSER_MODEL).toBe("gpt-5.4-nano-2026-03-17");
    expect(body.model).toBe(CS_COMPOSER_MODEL);
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(2000);
    expect(body.store).toBe(false);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
    expect(result.model).toBe(CS_COMPOSER_MODEL);
    expect(result.version).toBe(CS_COMPOSER_VERSION);
    expect(result.catalogueRows).toBeGreaterThan(20_000);
  });

  it("never sends the outgoing draft to the model", async () => {
    const fetcher = vi.fn().mockResolvedValue(targeting("a refrigerator repair service"));
    await composeAnswerAware(
      lead({
        postText: "My fridge stopped working",
        previousDraft: "Hi Casey, this is Alex. Could you kindly share your complete address?",
        suggestedRequirements: ["share your complete address"],
      }),
      { apiKey: "test-key", fetcher },
    );
    const sent = fetcher.mock.calls[0][1].body as string;
    expect(sent).not.toContain("previousDraft");
    expect(sent).not.toContain("this is Alex");
  });

  it("asks the sub-category's questions and records which were suppressed", async () => {
    const fetcher = vi.fn().mockResolvedValue(targeting("a gutter cleaning service", "gutter"));
    const result = await composeAnswerAware(
      lead({
        postText: "Need the gutters cleaned on my two story house",
        service: "Gutter Cleaning",
      }),
      { apiKey: "test-key", fetcher },
    );
    expect(result.plan.ladderKey).toBe("gutter|clean");
    expect(result.plan.questions.map((question) => question.key)).not.toContain("STORIES");
    expect(result.warnings).toContain("answered_STORIES");
  });

  it("flags a multi-item post so a reviewer can check the targeting", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(targeting("an appliance repair service", "refrigerator"));
    const result = await composeAnswerAware(
      lead({ postText: "My LG refrigerator is not cooling and the stove is dead" }),
      { apiKey: "test-key", fetcher },
    );
    expect(result.warnings).toContain("multiple_objects");
    expect(result.plan.targetObject).toBe("refrigerator");
    // The LG belongs to the fridge, so the brand is known for it...
    expect(result.plan.questions.map((question) => question.key)).not.toContain("BRAND/MODEL");
  });

  it("keeps a branded service's own words instead of a generic in-vocab opening", async () => {
    // The model collapses "Govee permanent lights" to the generic, in-vocabulary
    // "a light fixture"; that name reads as a different product. The opening
    // must fall back to the Service field, which keeps the brand.
    const fetcher = vi.fn().mockResolvedValue(targeting("the installation of a light fixture"));
    const result = await composeAnswerAware(
      lead({
        customerName: "Bradley",
        postText: "Hi, is this available?",
        context: "Customer needs a Govee lights installation.",
        service: "Govee permanent lights",
      }),
      { apiKey: "test-key", fetcher },
    );
    expect(result.plan.serviceContext).toMatch(/govee/i);
    expect(result.plan.serviceContext).not.toMatch(/fixture/i);
    expect(result.warnings).toContain("service_field_opening");
    const message = renderComposePlan(
      {
        customerName: "Bradley",
        service: "Govee permanent lights",
        reference: "Had a conversation on FB",
      },
      result.plan,
      "Alex",
    );
    expect(message).toMatch(/we had a conversation on Facebook regarding govee permanent lights/i);
  });

  it("leaves a generic service's opening to the model (no false brand fallback)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(targeting("a refrigerator repair service", "refrigerator"));
    const result = await composeAnswerAware(
      lead({ postText: "My fridge stopped working", service: "Appliance Repair" }),
      { apiKey: "test-key", fetcher },
    );
    expect(result.plan.serviceContext).toBe("a refrigerator repair service");
    expect(result.warnings).not.toContain("service_field_opening");
  });

  it("falls back to the first detected object when the model picks an unknown one", async () => {
    const fetcher = vi.fn().mockResolvedValue(targeting("a repair service", "spaceship"));
    const result = await composeAnswerAware(lead({ postText: "My fridge is broken" }), {
      apiKey: "test-key",
      fetcher,
    });
    expect(result.plan.targetObject).toBe("refrigerator");
    expect(result.warnings).toContain("retargeted");
  });

  it("fails closed on refusal or token-budget truncation", async () => {
    const fetcher = vi.fn().mockResolvedValue(targeting("a repair", "none", "length"));
    await expect(
      composeAnswerAware(lead({ postText: "Need repair" }), { apiKey: "test-key", fetcher }),
    ).rejects.toThrow(/incomplete/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade the model or drop controls on a provider validation error", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("unsupported parameter", { status: 400 }));
    await expect(
      composeAnswerAware(lead({ postText: "Need repair" }), { apiKey: "test-key", fetcher }),
    ).rejects.toThrow(/400/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries once on a rate limit, then gives up without a model switch", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(targeting("a repair service"));
    const result = await composeAnswerAware(lead({ postText: "Need repair" }), {
      apiKey: "test-key",
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).model).toBe(CS_COMPOSER_MODEL);
    expect(result.plan.serviceContext).toBe("a repair service");
  });

  it("never calls a model when there is no customer context", async () => {
    const fetcher = vi.fn();
    await expect(composeAnswerAware(lead({}), { apiKey: "test-key", fetcher })).rejects.toThrow(
      /context/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reduces any unexpected failure to a safe code", () => {
    expect(safeComposerError(new Error("Composer provider failed (500;request_failed)"))).toBe(
      "Composer provider failed (500;request_failed)",
    );
    expect(safeComposerError(new Error("Unsupported composer opening"))).toBe(
      "Unsupported composer opening",
    );
    // A message that might carry customer text never escapes.
    expect(safeComposerError(new Error("row 42 for 123 Example Street failed"))).toBe(
      "generation_failed",
    );
  });
});

describe("regression gates distinguish refinement from repetition", () => {
  it("accepts a specific diagnostic, but rejects the same generic fault question", () => {
    const test = { forbiddenPhrases: ["what issue", "what problem", "what is wrong"] };
    expect(
      scoreComposeReply(test, "Is the garage door stuck open or closed?", ["PROBLEM"]).pass,
    ).toBe(true);
    expect(
      scoreComposeReply(test, "What issue are you facing with the garage door?", ["PROBLEM"]).pass,
    ).toBe(false);
  });

  it("accepts a contextual 'both appliances' acknowledgement, without a dropped appliance", () => {
    const test = {
      mustMentionAny: [
        ["washer", "both appliances"],
        ["dryer", "both appliances"],
      ],
    };
    expect(
      scoreComposeReply(test, "Routine maintenance for both appliances.", ["PHOTO"]).pass,
    ).toBe(true);
    expect(scoreComposeReply(test, "This is for dryer maintenance only.", []).pass).toBe(false);
  });

  it("enforces the two-ask ceiling", () => {
    expect(scoreComposeReply({}, "message", ["PHOTO", "ADDRESS"]).pass).toBe(true);
    expect(scoreComposeReply({}, "message", ["PHOTO", "ADDRESS", "SIZE"]).pass).toBe(false);
  });
});
