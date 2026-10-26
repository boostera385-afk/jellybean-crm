import { describe, expect, it, vi } from "vitest";
import type { SelectedAsk } from "../../supabase/functions/_shared/cs-ask-policy";
import { composeAnswerAware } from "../../supabase/functions/_shared/cs-composer";
import {
  applyFit,
  checkFittedText,
  CS_FIT_PROMPT,
  FIT_SCHEMA,
} from "../../supabase/functions/_shared/cs-question-fit";

const ask = (intent: SelectedAsk["intent"], fragment: string, object: string | null = null) => ({
  intent,
  fragment,
  object,
});
const DRAWERS = ["ISO a handyman to rebuild the inside of six garage drawers."];
const photo = ask("PHOTO", "share a picture of the cabinets", "cabinet");
const address = ask("ADDRESS", "share your complete address");
const size = ask("SIZE", "let me know the size of the cabinets", "cabinet");

describe("fitting one question to the lead", () => {
  it("names the item the customer actually wrote", () => {
    expect(checkFittedText("share a picture of the drawers", photo, DRAWERS)).toBe(
      "share a picture of the drawers",
    );
    const floor = ask("SIZE", "let me know the size", "floor");
    expect(
      checkFittedText("let me know the size of the garage floor", floor, ["Garage floor"]),
    ).toBe("let me know the size of the garage floor");
  });

  it("keeps the team's wording when the fit adds a word from nowhere", () => {
    // "hinges" is in neither the question nor the lead.
    expect(checkFittedText("share a picture of the broken hinges", photo, DRAWERS)).toBe(
      photo.fragment,
    );
  });

  it("never borrows an item from another job's phrase", () => {
    // "spring" is in a team phrase for garage doors, but not in this lead: an
    // off-track door does not establish a broken spring.
    const replacement = ask("OWNERSHIP", "let me know if you already have the replacement");
    expect(
      checkFittedText("let me know if you already have the replacement spring", replacement, [
        "Garage door came off track",
      ]),
    ).toBe(replacement.fragment);
    expect(
      checkFittedText("let me know if you already have the replacement opener", replacement, [
        "Looking for someone who can replace my garage door opener.",
      ]),
    ).toBe("let me know if you already have the replacement opener");
    const pictures = ask("PHOTO", "share some pictures");
    expect(checkFittedText("share a few pictures of the drawers", pictures, DRAWERS)).toBe(
      "share a few pictures of the drawers",
    );
    expect(checkFittedText("share a picture of the furnace", pictures, DRAWERS)).toBe(
      pictures.fragment,
    );
  });

  it("keeps the team's wording when the fit asks something else", () => {
    expect(checkFittedText("let me know the size of the drawers", photo, DRAWERS)).toBe(
      photo.fragment,
    );
  });

  it("keeps the team's wording for anything that is no longer an ask in its form", () => {
    for (const text of [
      "share a picture of the drawers?",
      "a picture of the drawers",
      "share a picture of the drawers for a free visit",
      "",
      42,
    ])
      expect(checkFittedText(text, photo, DRAWERS)).toBe(photo.fragment);
  });
});

describe("choosing the questions", () => {
  const options = [photo, address, size];
  const fit = (questions: { id: string; text: string }[]) =>
    applyFit({ questions }, options, DRAWERS);

  it("swaps a question for another on the menu and fits its wording", () => {
    expect(
      fit([
        { id: "q1", text: "share a picture of the drawers" },
        { id: "q3", text: "let me know the size of the drawers" },
      ]),
    ).toEqual([
      { ...photo, fragment: "share a picture of the drawers" },
      { ...size, fragment: "let me know the size of the drawers" },
    ]);
  });

  it("puts the address last, as the team always does", () => {
    expect(
      fit([
        { id: "q2", text: "share your complete address" },
        { id: "q1", text: "share a picture of the drawers" },
      ])?.map((a) => a.intent),
    ).toEqual(["PHOTO", "ADDRESS"]);
  });

  it("refuses a choice the catalogue's rules forbid", () => {
    expect(fit([])).toBeNull();
    expect(fit([{ id: "q9", text: "share a picture" }])).toBeNull();
    expect(
      fit([
        { id: "q1", text: photo.fragment },
        { id: "q1", text: photo.fragment },
      ]),
    ).toBeNull();
    expect(
      fit([
        { id: "q1", text: photo.fragment },
        { id: "q2", text: address.fragment },
        { id: "q3", text: size.fragment },
      ]),
    ).toBeNull();
    const scope = ask("SCOPE", "let me know what exactly needs to be done");
    const problem = ask("PROBLEM", "let me know what issue you are facing");
    expect(
      applyFit(
        {
          questions: [
            { id: "q1", text: scope.fragment },
            { id: "q2", text: problem.fragment },
          ],
        },
        [scope, problem],
        DRAWERS,
      ),
    ).toBeNull();
    expect(applyFit("nonsense", options, DRAWERS)).toBeNull();
  });

  it("offers only menu ids, and treats the lead as data", () => {
    expect(FIT_SCHEMA(["q1", "q2"]).properties.questions.items.properties.id.enum).toEqual([
      "q1",
      "q2",
    ]);
    expect(CS_FIT_PROMPT).toMatch(/untrusted DATA/);
    expect(CS_FIT_PROMPT).toMatch(/Use only words that appear in the menu question or in the lead/);
  });
});

describe("the composer with fitting on", () => {
  const reply = (content: unknown) =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
      }),
      { status: 200 },
    );
  /** Answers each call by the schema it asks for, as the network would. */
  const model = (fitAnswer: (menu: { id: string; text: string }[]) => unknown) =>
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "cs_compose_target")
        return reply({
          serviceContext: "a handyman to rebuild six garage drawers",
          targetObject: "cabinet",
        });
      const answer = fitAnswer(payload.menu);
      return answer instanceof Response ? answer : reply(answer);
    });
  const input = {
    customerName: "Dana",
    postText: DRAWERS[0],
    service: "handyman",
  };

  it("sends the fitted questions", async () => {
    const fetcher = model((menu) => ({
      questions: [
        {
          id: menu.find((m) => /picture/.test(m.text))!.id,
          text: "share a picture of the drawers",
        },
        { id: menu.find((m) => /address/.test(m.text))!.id, text: "share your complete address" },
      ],
    }));
    const result = await composeAnswerAware(input, {
      apiKey: "k",
      fetcher,
      fitQuestions: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.plan.questions.map((q) => q.text)).toEqual([
      "share a picture of the drawers",
      "share your complete address",
    ]);
    expect(result.warnings).toContain("questions_fitted");
  });

  it("keeps the catalogue's questions when fitting fails", async () => {
    const off = await composeAnswerAware(input, {
      apiKey: "k",
      fetcher: model(() => ({ questions: [] })),
    });
    for (const answer of [
      new Response("{}", { status: 500 }),
      { questions: [{ id: "q99", text: "share a picture" }] },
    ]) {
      const result = await composeAnswerAware(input, {
        apiKey: "k",
        fetcher: model(() => answer),
        fitQuestions: true,
      });
      expect(result.plan.questions).toEqual(off.plan.questions);
      expect(result.warnings).toContain("fit_unavailable");
    }
  });

  it("does not ask the model at all unless fitting is turned on", async () => {
    const fetcher = model(() => ({ questions: [] }));
    await composeAnswerAware(input, { apiKey: "k", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
