import { describe, expect, it } from "vitest";
import {
  composeAnswerAware,
  renderComposePlan,
  type ComposerInput,
} from "../../supabase/functions/_shared/cs-composer";
import {
  maskNames,
  pickExamples,
  SEED_CORRECTIONS,
  usableCorrection,
} from "../../supabase/functions/_shared/cs-compose-examples";
import { intentOf } from "../../supabase/functions/_shared/cs-compose-review";

type Review = { problems: string[]; opening: string; questions: string[] } | "fail";

/** Mocks the three model calls: opening, question fitting, review. */
function fetcher(serviceContext: string, targetObject: string, review: Review) {
  const calls: string[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const name: string = body.response_format.json_schema.name;
    calls.push(`${name}:${body.model}`);
    const payload = JSON.parse(body.messages[1].content);
    let content: unknown;
    if (name === "cs_compose_target") content = { serviceContext, targetObject };
    else if (name === "cs_fit_questions")
      content = {
        questions: payload.suggested.filter(Boolean).map((id: string) => ({
          id,
          text: payload.menu.find((m: { id: string }) => m.id === id).text,
        })),
      };
    else if (review === "fail") return new Response("{}", { status: 400 });
    else content = review;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
      }),
    );
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function compose(input: ComposerInput, context: string, target: string, review: Review) {
  const { fn, calls } = fetcher(context, target, review);
  const result = await composeAnswerAware(input, {
    apiKey: "test",
    fitQuestions: true,
    review: {},
    fetcher: fn,
  });
  return { message: renderComposePlan(input, result.plan, "Alex"), result, calls };
}

const garage: ComposerInput = {
  customerName: "Casey",
  postText: "My garage door wheel popped off in the middle",
  service: "Garage Door Repair",
};

describe("review step", () => {
  it("applies a fix that stays inside the lead's and the team's words", async () => {
    const { message, result, calls } = await compose(
      garage,
      "a garage door repair service",
      "garage_door",
      {
        problems: ["opening missed the fault"],
        opening: "a garage door repair service because the wheel popped off",
        questions: ["share a picture of the garage door", "let me know your availability"],
      },
    );
    expect(message).toContain(
      "looking for a garage door repair service because the wheel popped off.",
    );
    expect(result.warnings).toContain("review_opening");
    expect(calls.some((c) => c.startsWith("cs_review_reply:gpt-5.4-mini"))).toBe(true);
  });

  it("keeps the draft when the review call fails", async () => {
    const { message, result } = await compose(
      garage,
      "a garage door repair service",
      "garage_door",
      "fail",
    );
    expect(result.warnings).toContain("review_unavailable");
    // "wheel popped off" already says what is wrong, so the draft asks for
    // the availability and address instead, and the failed review keeps it.
    expect(message).toMatch(
      /Could you kindly let me know your availability and share your complete address/,
    );
  });

  it("refuses a price, promise or invented detail", async () => {
    const { message, result } = await compose(
      garage,
      "a garage door repair service",
      "garage_door",
      {
        problems: [],
        opening: "a garage door repair service with a free estimate",
        questions: [
          "let me know what issue you are facing with your garage door",
          "share your complete address",
        ],
      },
    );
    expect(message).not.toMatch(/service with a free estimate/);
    expect(result.warnings).toContain("review_opening_refused");
  });

  it("refuses words that appear nowhere in the lead, draft, menu or examples", async () => {
    const { message, result } = await compose(
      garage,
      "a garage door repair service",
      "garage_door",
      {
        problems: [],
        opening: "a garage door repair service",
        questions: [
          "share the serial number of the torsion assembly",
          "share your complete address",
        ],
      },
    );
    expect(message).not.toMatch(/torsion/);
    expect(result.warnings).toContain("review_questions_refused");
  });

  it("does not let the reviewer replace a team rule's questions", async () => {
    const carpet = {
      customerName: "Casey",
      postText: "Need carpet cleaning",
      service: "Carpet Cleaning",
    };
    const { message, result } = await compose(carpet, "a carpet cleaning service", "carpet", {
      problems: [],
      opening: "a carpet cleaning service",
      questions: ["share a picture of the carpet area", "let me know your availability"],
    });
    expect(message).toMatch(/let me know the size/);
    expect(result.warnings).toContain("review_questions_refused");
  });

  it("refuses asking for a fact the customer already gave", async () => {
    const input = {
      customerName: "Casey",
      postText: "Something is wrong with the wiring in my kitchen, I live at 12 Oak Street",
      service: "Electrician",
    };
    const { message } = await compose(input, "an electrician for the kitchen wiring", "none", {
      problems: [],
      opening: "an electrician for the kitchen wiring",
      questions: ["share some pictures", "share your complete address"],
    });
    expect(message).not.toMatch(/complete address/);
  });

  it("keeps a good opening when the questions are refused", async () => {
    const { message, result } = await compose(
      garage,
      "a garage door repair service",
      "garage_door",
      {
        problems: [],
        opening: "a garage door repair service because the wheel popped off",
        questions: ["share the torsion warranty", "share your complete address"],
      },
    );
    expect(message).toContain("because the wheel popped off");
    expect(result.warnings).toEqual(
      expect.arrayContaining(["review_opening", "review_questions_refused"]),
    );
  });
});

describe("question kinds", () => {
  it.each([
    ["let me know the size of the picture", "SIZE"],
    ["share a picture of the floor", "PHOTO"],
    ["let me know which appliance you want to repair", "SCOPE"],
    ["let me know if you already have the lights", "OWNERSHIP"],
    ["share the brand name of the dryer", "BRAND/MODEL"],
    ["let me know what issue you are facing with your microwave", "PROBLEM"],
  ])("%s -> %s", (text, intent) => expect(intentOf(text)).toBe(intent));
});

describe("correction examples", () => {
  it("masks the customer and the sender", () => {
    expect(
      maskNames(
        "Hi Carol, this is Jason. I saw that you are looking for a rug cleaning service.",
        "CAROL Smith",
      ),
    ).toBe("Hi {name}, this is {agent}. I saw that you are looking for a rug cleaning service.");
  });

  it("ignores saved edits that are not the team's message form or hold contact details", () => {
    const base = SEED_CORRECTIONS[0];
    expect(usableCorrection({ ...base, corrected: "call me back" })).toBe(false);
    expect(
      usableCorrection({ ...base, corrected: base.corrected.replace("in sq ft", "at 555 1234") }),
    ).toBe(false);
    expect(usableCorrection(base)).toBe(true);
  });

  it("shows the examples for the same kind of job first", () => {
    const picked = pickExamples("Rug Cleaning", "a rug cleaning service");
    expect(picked[0].service).toBe("Rug Cleaning");
    expect(picked.slice(0, 3).some((e) => e.service === "Carpet Cleaning")).toBe(true);
  });

  it("puts a saved correction ahead of the seed for the same job", () => {
    const saved = {
      service: "Rug Cleaning",
      draft:
        "Hi {name}, this is {agent}. I saw that you are looking for a rug cleaning service. Could you kindly share some pictures, so I can check the schedule for a visit?",
      corrected:
        "Hi {name}, this is {agent}. I saw that you are looking for a rug cleaning service. Could you kindly share a picture of the rug and let me know the size of the rug, so I can check the schedule for a visit?",
    };
    expect(pickExamples("Rug Cleaning", "a rug cleaning service", [saved])[0]).toBe(saved);
  });
});

describe("live draft fixes (Nov 18)", () => {
  it("lets the reviewer replace a team question the lead already answers", async () => {
    const dryer = {
      customerName: "Casey",
      postText: "My dryer has a problem",
      service: "Dryer Repair",
    };
    const { message, result } = await compose(dryer, "a dryer repair service", "dryer", {
      problems: ["issue already given"],
      opening: "a dryer repair service",
      questions: ["send me a picture of the dryer", "share the brand name of the dryer"],
    });
    expect(result.warnings).toContain("review_questions");
    expect(message).toMatch(/send me a picture of the dryer and share the brand name/);
  });

  it("puts the availability before the address", async () => {
    const { message } = await compose(garage, "a garage door repair service", "garage_door", {
      problems: [],
      opening: "a garage door repair service",
      questions: ["share your complete address", "let me know your availability"],
    });
    expect(message).toMatch(/let me know your availability and share your complete address/);
  });
});
