import { describe, expect, it } from "vitest";
import {
  composeAnswerAware,
  nameCase,
  renderComposePlan,
  type ComposerInput,
} from "../../supabase/functions/_shared/cs-composer";
import { applyFit } from "../../supabase/functions/_shared/cs-question-fit";
import type { SelectedAsk } from "../../supabase/functions/_shared/cs-ask-policy";

/**
 * Drafts the CS team corrected by hand (Nov 2026). The model is mocked to
 * return the corrected opening, and to try the swap the team kept fixing:
 * a job question traded for "share your complete address".
 */
function mockFetcher(serviceContext: string, targetObject: string) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const payload = JSON.parse(body.messages[1].content);
    const content =
      body.response_format.json_schema.name === "cs_compose_target"
        ? { serviceContext, targetObject }
        : {
            questions: payload.menu
              .filter((item: { text: string }, i: number) => i === 0 || /address/.test(item.text))
              .slice(0, 2)
              .map((item: { id: string; text: string }) => ({ id: item.id, text: item.text })),
          };
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
      }),
    );
  }) as unknown as typeof fetch;
}

async function compose(
  input: ComposerInput,
  serviceContext: string,
  targetObject = "none",
  sender = "Alex",
) {
  const result = await composeAnswerAware(input, {
    apiKey: "test",
    fitQuestions: true,
    fetcher: mockFetcher(serviceContext, targetObject),
  });
  return renderComposePlan(input, result.plan, sender);
}

const asks = (message: string) => message.replace(/^.*Could you kindly /, "Could you kindly ");

describe("team corrections", () => {
  it.each([
    [
      "carpet",
      { customerName: "CAROL", postText: "Need carpet cleaning", service: "Carpet Cleaning" },
      "a carpet cleaning service",
      "carpet",
      "Could you kindly share a picture of the carpet area and let me know the size, so I can check the schedule for a visit?",
    ],
    [
      "rug",
      { customerName: "Sonny", postText: "Rug cleaning", service: "Rug Cleaning" },
      "a rug cleaning service",
      "carpet",
      "Could you kindly share a picture of the rug area and let me know the size, so I can check the schedule for a visit?",
    ],
    [
      "drywall",
      { customerName: "Nicole", postText: "Need drywall repair", service: "Drywall Repair" },
      "a drywall repair service",
      "drywall",
      "Could you kindly share a picture of the drywall that needs to be repaired and the size of the drywall area in sq ft, so I can check the schedule for a visit?",
    ],
    [
      "dryer",
      { customerName: "Sue", postText: "Need dryer repair", service: "Dryer Repair" },
      "a dryer repair service",
      "dryer",
      "Could you kindly let me know what issue you are facing with your dryer and share the brand name of the dryer, so I can check the schedule for a visit?",
    ],
    [
      "microwave",
      { customerName: "Melanie", postText: "Microwave repair needed", service: "Microwave Repair" },
      "a microwave repair service",
      "microwave",
      "Could you kindly let me know what issue you are facing with your microwave and share the brand name of the microwave, so I can check the schedule for a visit?",
    ],
    [
      "unnamed appliance",
      { customerName: "Cyn", postText: "Need appliance repair", service: "Appliance Repair" },
      "an appliance repair service",
      "none",
      "Could you kindly let me know which appliance you want to repair and share your complete address, so I can check the schedule for a visit?",
    ],
    [
      "dryer vent",
      { customerName: "Robert", postText: "Dryer vent cleaning", service: "Dryer Vent Cleaning" },
      "a dryer vent cleaning service",
      "dryer_vent",
      "Could you kindly let me know your availability and share your complete address, so I can check the schedule for a visit?",
    ],
    [
      "windows",
      { customerName: "Patricia", postText: "Need window cleaning", service: "Window Cleaning" },
      "a window cleaning service",
      "window",
      "Could you kindly let me know how many windows need to be cleaned and share pictures of the windows, so I can check the schedule for a visit?",
    ],
    [
      "ceiling fan",
      {
        customerName: "Greg",
        postText: "Electrician to replace a ceiling fan with a new fixture",
        service: "Electrician",
      },
      "an electrician to replace a ceiling fan with a new fixture",
      "ceiling_fan",
      "Could you kindly let me know if you already have the replacement fan and share a picture of the area where the fan needs to be installed, so I can check the schedule for a visit?",
    ],
    [
      "christmas lights",
      {
        customerName: "Chris",
        postText: "Permanent Christmas light installation, area circled in red",
        service: "Christmas Light Installation",
      },
      "a permanent Christmas light installation service",
      "christmas_lights",
      "Could you kindly share a picture of where you want to install the lights and let me know if you already have the lights, so I can check the schedule for a visit?",
    ],
    [
      "garage door",
      { customerName: "Mandi", postText: "Need garage door repair", service: "Garage Door Repair" },
      "a garage door repair service",
      "garage_door",
      "Could you kindly let me know what issue you are facing with your garage door and share your complete address, so I can check the schedule for a free estimate visit?",
    ],
    [
      "siding",
      { customerName: "Tim", postText: "Siding repair and improvement", service: "Siding Repair" },
      "a siding repair service",
      "none",
      "Could you kindly share a picture of the siding area that needs to be repaired and let me know your availability, so I can check the schedule for a visit?",
    ],
    [
      "popcorn ceiling",
      {
        customerName: "Kathryn",
        postText: "AC unit and popcorn ceiling repair",
        service: "Popcorn Ceiling Repair",
      },
      "an ac unit and popcorn ceiling repair service",
      "ac_unit",
      "Could you kindly share a picture of the popcorn ceiling that needs to be repaired and let me know the ceiling height, so I can check the schedule for a visit?",
    ],
    [
      "picture hanging",
      { customerName: "Linda", postText: "Handyman to hang a large picture", service: "Handyman" },
      "a handyman service to hang a large picture",
      "none",
      "Could you kindly share pictures of the area where the picture needs to be hung and let me know the size of the picture, so I can check the schedule for a visit?",
    ],
    [
      "moving",
      { customerName: "Alfredo", postText: "Need a local moving service", service: "Moving" },
      "a moving service",
      "none",
      "Could you kindly share pictures of the items that need to be moved and the complete pickup and drop off addresses, so I can check the schedule for a visit?",
    ],
  ])("%s: asks what the team corrected it to", async (_, input, context, target, expected) => {
    expect(asks(await compose(input, context, target))).toBe(expected);
  });

  it("does not ask for a fact the customer already gave", async () => {
    const message = await compose(
      {
        customerName: "Sue",
        postText: "Need my Whirlpool dryer repaired",
        service: "Dryer Repair",
      },
      "a Whirlpool dryer repair service",
      "dryer",
    );
    expect(message).not.toMatch(/brand name/);
    expect(message).toMatch(/what issue you are facing with your dryer/);
  });

  it("skips the popcorn ceiling questions when the opening does not name it", async () => {
    const message = await compose(
      { customerName: "Kathryn", postText: "AC unit and popcorn ceiling repair", service: "AC" },
      "an ac unit repair service",
      "ac_unit",
    );
    expect(message).not.toMatch(/popcorn ceiling that needs/);
  });
});

describe("question fitting", () => {
  const ask = (intent: SelectedAsk["intent"], fragment: string): SelectedAsk => ({
    intent,
    object: null,
    fragment,
  });
  const photo = ask("PHOTO", "share a picture of the deck");
  const size = ask("SIZE", "let me know the size of the deck");
  const address = ask("ADDRESS", "share your complete address");
  const options = [photo, size, address];
  const pick = (...ids: string[]) => ({
    questions: ids.map((id) => ({ id, text: options[Number(id.slice(1)) - 1].fragment })),
  });

  it("keeps the suggested pair when the model swaps a job question for the address", () => {
    expect(applyFit(pick("q1", "q3"), options, ["deck"], [photo, size])).toBeNull();
  });

  it("keeps the suggested pair when the model drops the second question", () => {
    expect(applyFit(pick("q1"), options, ["deck"], [photo, size])).toBeNull();
  });

  it("still lets the model reorder or reword within the job questions", () => {
    expect(applyFit(pick("q2", "q1"), options, ["deck"], [photo, size])).toHaveLength(2);
  });
});

describe("nameCase", () => {
  it.each([
    ["CAROL", "Carol"],
    ["carol", "Carol"],
    ["MARY-ANN", "Mary-Ann"],
    ["McKenzie", "McKenzie"],
    ["JD", "JD"],
    ["Nicole", "Nicole"],
  ])("%s -> %s", (input, expected) => expect(nameCase(input)).toBe(expected));
});

describe("facts from 15 days of real leads", () => {
  it.each([
    [
      "own lights",
      {
        customerName: "Casey",
        postText: "Looking for someone to install our own lights.",
        service: "Holiday Light Installation",
      },
      "a holiday light installation service",
      "christmas_lights",
      /already have the lights/,
    ],
    [
      "washer not spinning",
      {
        customerName: "Casey",
        postText: "My washer is not spinning.",
        service: "Appliance Repair",
      },
      "a washer repair service",
      "washer",
      /what issue/,
    ],
    [
      "fridge isnt cooling",
      {
        customerName: "Casey",
        postText: "My Samsung refrigerator isnt cooling or freezing.",
        service: "Appliance Repair",
      },
      "a Samsung refrigerator repair service",
      "refrigerator",
      /what issue|brand name/,
    ],
    [
      "garage door shaking",
      {
        customerName: "Casey",
        postText: "My garage door is shaking quite a bit whenever it opens.",
        service: "Garage Door",
      },
      "a garage door repair service",
      "garage_door",
      /what issue/,
    ],
  ])("%s: not asked again", async (_, input, context, target, asked) => {
    expect(asks(await compose(input, context, target))).not.toMatch(asked);
  });

  it("gutter cleaning asks single or double story when the post does not say", async () => {
    const message = await compose(
      { customerName: "Casey", postText: "Need my gutters cleaned", service: "Gutter Cleaning" },
      "a gutter cleaning service",
      "gutter",
    );
    expect(asks(message)).toBe(
      "Could you kindly let me know if your house is single or double story and share your complete address, so I can check the schedule for a visit?",
    );
  });

  it("garage door replies offer a free estimate visit", async () => {
    const message = await compose(
      { customerName: "Casey", postText: "Need garage door repair", service: "Garage Door" },
      "a garage door repair service",
      "garage_door",
    );
    expect(message).toMatch(/so I can check the schedule for a free estimate visit\?$/);
  });
});

describe("first live drafts (Nov 18)", () => {
  it.each([
    [
      "1 story house",
      {
        customerName: "Casey",
        postText: "I need someone to clean my gutters on a 1 story house.",
        service: "Gutter Cleaning",
      },
      "a gutter cleaning service for a 1 story house",
      "gutter",
      /single or double story/,
    ],
    [
      "button broke off",
      {
        customerName: "Casey",
        postText: "Anyone that knows how to fix a dryer? Middle control button broke off.",
        service: "Appliance Repair",
      },
      "a dryer repair service because the middle control button broke off",
      "dryer",
      /what issue/,
    ],
    [
      "water keeps going out",
      {
        customerName: "Casey",
        postText: "My dishwasher, the water keeps going out when we put dishes inside.",
        service: "Appliance Repair",
      },
      "a dishwasher repair service",
      "dishwasher",
      /what issue/,
    ],
  ])("%s: not asked again", async (_, input, context, target, asked) => {
    expect(asks(await compose(input, context, target))).not.toMatch(asked);
  });
});

describe("live drafts the team flagged (Nov 18)", () => {
  it("Nina: a wrong Service field does not replace the customer's job", async () => {
    const message = await compose(
      {
        customerName: "Nina",
        postText: "I'm looking for a good and reasonably priced carpet and grout cleaner.",
        context: "Looking for a carpet and grout cleaner.",
        service: "Gutter Cleaning",
      },
      "a carpet and grout cleaning service",
      "carpet",
    );
    expect(message).toContain("looking for a carpet and grout cleaning service.");
    expect(message).not.toMatch(/gutter/i);
  });

  it("Lore: movers loading a fridge is a moving job", async () => {
    const message = await compose(
      {
        customerName: "Lore",
        postText:
          "Looking for moving support for a friend, loading a fridge and heavy bed parts and lots of bags and boxes.",
        context: "Needs movers to load a fridge, bed parts, bags, and boxes.",
        service: "moving service",
      },
      "a moving service to load a fridge, heavy bed parts, bags, and boxes",
      "refrigerator",
    );
    expect(asks(message)).toMatch(
      /^Could you kindly share pictures of the items that need to be moved/,
    );
    expect(message).not.toMatch(/what issue|brand name/);
  });

  it("Justina: lights owned and pictures attached still asks two questions", async () => {
    const message = await compose(
      {
        customerName: "Justina",
        postText:
          "Hi, can you do estimate to do Christmas light on a front my house? We have lights",
        service: "Christmas Lights Installation",
        imageCount: 1,
        reference: "Had a conversation on FB",
      },
      "Christmas lights installation service for the front of your house",
      "christmas_lights",
    );
    expect(asks(message)).toBe(
      "Could you kindly let me know if your house is single or double story and share your complete address, so I can check the schedule for a visit?",
    );
  });

  it("Kristie: 'do you provide the lights?' is not answered with 'do you have the lights?'", async () => {
    const message = await compose(
      {
        customerName: "Kristie",
        postText: "Do you install lights in Macon? Do you provide the lights or do we?",
        service: "Christmas Lights Installation",
        imageCount: 3,
        reference: "Had a conversation on FB",
      },
      "Christmas lights installation service",
      "christmas_lights",
    );
    expect(message).not.toMatch(/already have the lights|share a picture/);
    expect(message).toMatch(/single or double story/);
  });

  it("Sandra: cabinet painting with a picture attached asks how many cabinets", async () => {
    const message = await compose(
      {
        customerName: "Sandra",
        postText: "Need a handyman for cabinet painting.",
        service: "General Handyman Service",
        imageCount: 1,
      },
      "a cabinet painting service",
      "cabinet",
    );
    expect(asks(message)).toBe(
      "Could you kindly let me know how many cabinets need to be painted and share your complete address, so I can check the schedule for a visit?",
    );
  });
});
