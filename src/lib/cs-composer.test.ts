import { describe, it, expect, vi } from "vitest";
import {
  CS_COMPOSER_MODEL,
  CS_COMPOSER_VERSION,
  CS_COMPOSER_PROMPT,
  composeAnswerAware,
  parseComposePlan,
  renderComposePlan,
  validateAndFilterPlan,
  scoreComposeReply,
  type ComposerInput,
  type ComposePlan,
  type ComposeQuestion,
  type KnownFact,
} from "../../supabase/functions/_shared/cs-composer";

const question = (key: ComposeQuestion["key"], text: string, subject = "job"): ComposeQuestion => ({
  key,
  text,
  subject,
  why: "Needed to scope this job",
});
const plan = (questions: ComposeQuestion[], facts: KnownFact[] = []): ComposePlan => ({
  serviceContext: "a repair",
  openingLine: "",
  facts,
  questions,
});
const lead = (input: Partial<ComposerInput>): ComposerInput => ({
  customerName: "Casey Test",
  ...input,
});
const address = question("address", "Could you share your complete address?");
const timing = question("availability", "What is your availability?");
const photo = question("photos", "Could you send a photo of the repair area?");
const issue = question("problem", "What issue are you facing with the appliance?");

// Source patterns from cleaned_data.csv, NOT its composed-message labels.
// No real customer names/phone numbers/addresses are committed.
describe("answer-aware question guards (CSV regression patterns)", () => {
  it.each([
    ["post address", lead({ postText: "Repair at 123 Example Street, Denver CO" })],
    [
      "saved notes address",
      lead({ postText: "Need repair", notes: ["Customer supplied 456 Sample Avenue"] }),
    ],
    ["main area address", lead({ postText: "Need repair", mainArea: "789 Demo Road" })],
    ["sub area address", lead({ postText: "Need repair", subArea: "432 Test Boulevard" })],
    ["address on file", lead({ notes: ["Address on file"] })],
    ["address already supplied", lead({ notes: ["Address already shared"] })],
  ])("does not re-ask %s", (_name, input) => {
    const result = validateAndFilterPlan(input, plan([address]));
    expect(result.plan.questions).toHaveLength(0);
    expect(result.warnings).toContain("address_already_known");
  });
  it.each(["Denver, CO", "78738", "an 11x12 room", "a 2800 sq ft basement", "LG model 12345"])(
    "does not mistake %s for a full street address",
    (value) => {
      expect(
        validateAndFilterPlan(lead({ postText: value }), plan([address])).plan.questions,
      ).toHaveLength(1);
    },
  );
  it("does not interpret an outgoing draft as known customer facts", () => {
    const result = validateAndFilterPlan(
      lead({ previousDraft: "The job is at 123 Example Street tomorrow. Photo attached." }),
      plan([address, timing]),
    );
    expect(result.plan.questions).toHaveLength(2);
  });
  it.each([
    "picture below",
    "photo attached",
    "I've posted pictures",
    "I sent photos",
    "see the picture",
  ])("does not request a photo when source says %s", (postText) => {
    expect(validateAndFilterPlan(lead({ postText }), plan([photo])).plan.questions).toHaveLength(0);
  });
  it("does not pretend screenshots prove a job photo has been sent", () => {
    expect(
      validateAndFilterPlan(lead({ postText: "Need repair", imageCount: 2 }), plan([photo])).plan
        .questions,
    ).toHaveLength(1);
  });
  it.each(["No photos attached", "I have not sent photos", "I haven't sent pictures"])(
    "does not treat negated photo evidence as supplied: %s",
    (postText) => {
      expect(validateAndFilterPlan(lead({ postText }), plan([photo])).plan.questions).toHaveLength(
        1,
      );
    },
  );
  it.each(["tomorrow", "today after 3pm", "ASAP", "within the next day or two", "Friday morning"])(
    "does not re-ask general availability after %s",
    (postText) => {
      expect(validateAndFilterPlan(lead({ postText }), plan([timing])).plan.questions).toHaveLength(
        0,
      );
    },
  );
  it.each([
    "Whirlpool freezer drawer not closing and frost buildup",
    "Hot tub has no circulation",
    "Dishwasher not working",
    "Fridge isn't cooling; it is leaking",
    "Off-track garage door",
  ])("does not re-ask a described symptom: %s", (postText) => {
    expect(validateAndFilterPlan(lead({ postText }), plan([issue])).plan.questions).toHaveLength(0);
  });
  it("allows a symptom question when no symptom was provided", () => {
    expect(
      validateAndFilterPlan(lead({ postText: "LG freezer repair recommendation?" }), plan([issue]))
        .plan.questions,
    ).toHaveLength(1);
  });
  it.each(["Move the hot tub 50 feet to the backyard", "Load a bed and sofa into a moving van"])(
    "does not invent a drop-off route: %s",
    (postText) => {
      const q = question("dropoff_address", "What is the pickup and drop-off address?");
      expect(validateAndFilterPlan(lead({ postText }), plan([q])).plan.questions).toHaveLength(0);
    },
  );
  it("uses supported evidence to prevent repeated brand/dimension/ownership questions", () => {
    for (const [key, subject, value] of [
      ["brand", "refrigerator", "Whirlpool"],
      ["dimensions", "room", "11x12"],
      ["ownership", "lights", "I already have the lights"],
    ] as const) {
      const fact = { key, subject, value, evidence: value };
      const q = question(key, "Could you tell me this detail?", subject);
      expect(
        validateAndFilterPlan(lead({ postText: value }), plan([q], [fact])).plan.questions,
      ).toHaveLength(0);
    }
  });
  it("does not apply a known refrigerator brand to a different appliance", () => {
    const fact: KnownFact = {
      key: "brand",
      subject: "refrigerator",
      value: "LG",
      evidence: "LG refrigerator",
    };
    const q = question("brand", "What brand is the stove?", "stove");
    expect(
      validateAndFilterPlan(lead({ postText: "LG refrigerator and a stove" }), plan([q], [fact]))
        .plan.questions,
    ).toHaveLength(1);
  });
  it("does not mistake a city fact for a complete street address", () => {
    const fact: KnownFact = { key: "address", subject: "job", value: "Denver", evidence: "Denver" };
    expect(
      validateAndFilterPlan(lead({ mainArea: "Denver" }), plan([address], [fact])).plan.questions,
    ).toHaveLength(1);
  });
  it("keeps specific scope refinements even when the general job is known", () => {
    const fact: KnownFact = {
      key: "scope",
      subject: "basement",
      value: "paint basement",
      evidence: "paint basement",
    };
    const q = question(
      "scope",
      "Should painting include the ceiling as well as the walls?",
      "basement",
    );
    expect(
      validateAndFilterPlan(lead({ postText: "Need to paint basement" }), plan([q], [fact])).plan
        .questions,
    ).toHaveLength(1);
  });
  it("keeps a specific diagnostic question without re-asking the generic fault", () => {
    const fact: KnownFact = {
      key: "problem",
      subject: "dishwasher",
      value: "not working",
      evidence: "not working",
    };
    const q = question("problem", "Does the dishwasher display an error code?", "dishwasher");
    expect(
      validateAndFilterPlan(lead({ postText: "Dishwasher not working" }), plan([q], [fact])).plan
        .questions,
    ).toHaveLength(1);
  });
  it("catches a repeated brand even if the model forgot to extract the known fact", () => {
    const q = question("brand", "What brand is the refrigerator?", "refrigerator");
    expect(
      validateAndFilterPlan(lead({ postText: "My Whirlpool refrigerator has frost" }), plan([q]))
        .plan.questions,
    ).toHaveLength(0);
  });
  it("rejects fabricated fact evidence rather than hiding valid questions", () => {
    const fact: KnownFact = {
      key: "address",
      subject: "job",
      value: "123 Example Street",
      evidence: "123 Example Street",
    };
    const result = validateAndFilterPlan(
      lead({ postText: "Need repair" }),
      plan([address], [fact]),
    );
    expect(result.plan.questions).toHaveLength(1);
    expect(result.warnings).toContain("unsupported_fact");
  });
  it("cannot evade the address guard by labelling the question other", () => {
    const q = { ...address, key: "other" as const };
    expect(
      validateAndFilterPlan(lead({ notes: ["123 Example Street"] }), plan([q])).plan.questions,
    ).toHaveLength(0);
  });
  it("drops duplicate questions and never replaces them with address filler", () => {
    const result = validateAndFilterPlan(
      lead({ postText: "Need repair" }),
      plan([address, address]),
    );
    expect(result.plan.questions).toEqual([address]);
    expect(result.warnings).toContain("duplicate_question");
  });
  it("does not ask unsafe disassembly or leak placeholders", () => {
    const q = question("access", "Could you remove the electrical panel cover?");
    expect(validateAndFilterPlan(lead({}), plan([q])).plan.questions).toHaveLength(0);
    expect(() =>
      validateAndFilterPlan(lead({}), { ...plan([]), serviceContext: "(Requirements)" }),
    ).toThrow();
  });
  it.each([
    "I'll call you tomorrow.",
    "We are licensed and insured.",
    "We can come tomorrow.",
    "The visit is free.",
    "A free estimate visit.",
    "The price is $99.",
  ])("rejects unsupported business claims: %s", (openingLine) => {
    expect(() => validateAndFilterPlan(lead({}), { ...plan([]), openingLine })).toThrow();
  });
  it("renders zero or one question naturally without 'confirm the details'", () => {
    const input = lead({});
    expect(renderComposePlan(input, plan([]), "Alex")).toBe(
      "Hi Casey, this is Alex. I saw you need a repair.",
    );
    const msg = renderComposePlan(input, plan([address]), "Alex");
    expect(msg.match(/\?/g)).toHaveLength(1);
    expect(msg).not.toMatch(/so I can|confirm the details|kindly/);
  });
  it("rejects malformed, truncated or excessive plans", () => {
    expect(() =>
      parseComposePlan({
        serviceContext: "repair",
        openingLine: "",
        facts: [],
        questions: [address, timing, photo],
      }),
    ).toThrow();
    expect(() => parseComposePlan({ serviceContext: "repair", questions: [] })).toThrow();
    expect(() => parseComposePlan({ ...plan([]), serviceContext: 123 })).toThrow();
  });
  it("has explicit case guidance instead of an address quota", () => {
    expect(CS_COMPOSER_PROMPT).toContain("An address is NOT mandatory");
    expect(CS_COMPOSER_PROMPT).toContain("11x12");
    expect(CS_COMPOSER_PROMPT).not.toContain("most common second ask");
  });
  it("removes an unsolicited pricing preamble without inventing another question", () => {
    const p = { ...plan([photo]), openingLine: "Pricing depends on the scope." };
    const result = validateAndFilterPlan(lead({ postText: "I own lights; please hang them" }), p);
    expect(result.plan.openingLine).toBe("");
    expect(result.plan.questions).toEqual([photo]);
    expect(result.warnings).toContain("unsolicited_pricing_removed");
  });
  it("keeps a safe pricing answer when the customer requested a quote", () => {
    const p = { ...plan([photo]), openingLine: "Pricing depends on the scope." };
    expect(
      validateAndFilterPlan(lead({ postText: "Please quote for hanging lights" }), p).plan
        .openingLine,
    ).toBe(p.openingLine);
  });
});

const response = (p: ComposePlan, finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finish, message: { content: JSON.stringify(p) } }],
    }),
    { status: 200 },
  );

describe("the exact shared generation pipeline", () => {
  it("always performs independent review using full original saved context", async () => {
    const original = lead({
      postText: "Need repair",
      notes: ["Address on file"],
      previousDraft: "Old outgoing draft",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(plan([address])))
      .mockResolvedValueOnce(response(plan([])));
    const result = await composeAnswerAware(original, { apiKey: "test-key", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetcher.mock.calls[0][1].body);
    const second = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(CS_COMPOSER_MODEL).toBe("gpt-5.4-nano-2026-03-17");
    expect(first.model).toBe("gpt-5.4-nano-2026-03-17");
    expect(second.model).toBe("gpt-5.4-nano-2026-03-17");
    expect(result.model).toBe("gpt-5.4-nano-2026-03-17");
    expect(first.max_completion_tokens).toBe(6000);
    expect(first.reasoning_effort).toBe("medium");
    expect(second.response_format).toEqual(first.response_format);
    expect(first.response_format.json_schema.strict).toBe(true);
    expect(first).not.toHaveProperty("temperature");
    expect(first).not.toHaveProperty("max_tokens");
    expect(first.store).toBe(false);
    expect(JSON.parse(second.messages[1].content).lead).toEqual(original);
    expect(second.messages[0].content).toContain("independent final reviewer");
    expect(result.version).toBe(CS_COMPOSER_VERSION);
    expect(result.plan.questions).toHaveLength(0);
  });
  it("fails closed on refusal or token-budget truncation", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(plan([address]), "length"));
    await expect(
      composeAnswerAware(lead({ postText: "Need repair" }), { apiKey: "test-key", fetcher }),
    ).rejects.toThrow(/incomplete/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not downgrade model or drop controls on provider validation errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("unsupported parameter", { status: 400 }));
    await expect(
      composeAnswerAware(lead({ postText: "Need repair" }), { apiKey: "test-key", fetcher }),
    ).rejects.toThrow(/400/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never calls a model for missing customer context", async () => {
    const fetcher = vi.fn();
    await expect(composeAnswerAware(lead({}), { apiKey: "test-key", fetcher })).rejects.toThrow(
      /context/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("regression gates distinguish refinement from repetition", () => {
  it("accepts a specific diagnostic, but rejects the same generic fault question", () => {
    const test = { forbiddenPhrases: ["what issue", "what problem", "what is wrong"] };
    expect(
      scoreComposeReply(test, "Is the garage door stuck open or closed?", ["problem"]).pass,
    ).toBe(true);
    expect(
      scoreComposeReply(test, "What issue are you facing with the garage door?", ["problem"]).pass,
    ).toBe(false);
  });
  it("accepts a contextual 'both appliances' acknowledgement, without accepting a dropped appliance", () => {
    const test = {
      mustMentionAny: [
        ["washer", "both appliances"],
        ["dryer", "both appliances"],
      ],
    };
    expect(
      scoreComposeReply(
        test,
        "Routine maintenance for both appliances. Is the dryer gas or electric?",
        ["installation_type"],
      ).pass,
    ).toBe(true);
    expect(scoreComposeReply(test, "This is for dryer maintenance only.", []).pass).toBe(false);
  });
});
