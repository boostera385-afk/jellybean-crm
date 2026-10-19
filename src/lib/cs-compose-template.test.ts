import { describe, it, expect } from "vitest";
import {
  COMPOSE_TEMPLATES,
  DEFAULT_CS_COMPOSE_TEMPLATE,
  firstName,
  renderCsComposeSuggestion,
  requirementForLead,
  serviceContextForLead,
  type SuggestionLead,
} from "./cs-compose-template";

const SCHEDULE = COMPOSE_TEMPLATES[0].template;
const lead = (input: Partial<SuggestionLead>): SuggestionLead => ({
  customer_name: "Casey Test",
  ...input,
});

describe("the suggestion never ships a placeholder or a pasted sentence", () => {
  it.each(COMPOSE_TEMPLATES.map((entry) => [entry.name, entry.template] as const))(
    "%s leaves nothing unfilled",
    (_name, template) => {
      const message = renderCsComposeSuggestion(
        template,
        lead({ service: "Refrigerator Repair", post_text: "Anyone able to look at my fridge?" }),
      );
      expect(message).not.toMatch(/\(/);
      expect(message).not.toMatch(/\)/);
      expect(message).not.toMatch(/\.\./);
      expect(message).not.toMatch(/\s{2,}/);
      expect(message).not.toMatch(/\s[.,?!]/);
    },
  );

  it("fills the Requirement slot that used to go out verbatim", () => {
    const message = renderCsComposeSuggestion(
      DEFAULT_CS_COMPOSE_TEMPLATE,
      lead({ service: "Gutter Cleaning", post_text: "Looking for someone to clean gutters" }),
    );
    expect(message).not.toContain("(Requirement)");
    expect(message).toContain(
      "Could you kindly let me know if your house is single or double story " +
        "and share your complete address, so I can check the schedule for a visit?",
    );
  });

  it("does not paste the whole context after 'looking for'", () => {
    const message = renderCsComposeSuggestion(
      SCHEDULE,
      lead({
        service: "Refrigerator Repair",
        context: "Customer needs refrigerator repair, not cooling.",
      }),
    );
    expect(message).toContain("looking for a refrigerator repair service.");
    expect(message).not.toContain("Customer needs");
  });

  it("drops a placeholder a custom template invented, with its connector", () => {
    expect(
      renderCsComposeSuggestion(
        "Hi (Person first name), this is (Sender). About (Service Context) - (Mystery Field), thanks!",
        lead({ service: "plumber" }),
      ),
    ).toBe("Hi Casey, this is Alex. About a plumber, thanks!");
  });
});

describe("the service context reads correctly after 'looking for'", () => {
  it.each([
    ["Garage Door Repair", "a garage door repair service"],
    ["General Handyman Service", "a handyman service"],
    ["plumber", "a plumber"],
    ["electrician", "an electrician"],
    ["Carpet Cleaning Service", "a carpet cleaning service"],
  ])("%s -> %s", (service, expected) => {
    expect(serviceContextForLead(lead({ service }))).toBe(expected);
  });

  it("falls back to the detected job when the service column is empty", () => {
    expect(
      serviceContextForLead(
        lead({
          service: null,
          post_text: "Looking for someone to fix my garage door, it is off track",
        }),
      ),
    ).toBe("a garage door repair service");
  });

  it("falls back to a trimmed phrase from the customer's own words", () => {
    expect(
      serviceContextForLead(
        lead({ service: null, context: "Looking for someone to seal a driveway" }),
      ),
    ).toBe("a driveway service");
  });

  it("documents the single phrase not taken from the delivered messages", () => {
    // Every ask phrase is lifted verbatim from the export (asserted over the
    // whole catalogue in cs-ask-catalogue.test.ts). This last-resort service
    // context is the one exception, reached on 0.41% of leads. If this ever
    // needs to change it is a copy decision, not a measured one.
    expect(serviceContextForLead(lead({ service: null, context: "help" }))).toBe(
      "the service you need",
    );
  });

  it("never produces a bare noun with an article", () => {
    // "help" would otherwise render as "a help".
    const phrase = serviceContextForLead(lead({ service: null, context: "Customer needs help" }));
    expect(phrase).toBe("the service you need");
    expect(phrase).not.toMatch(/^an? \w+$/);
  });
});

describe("the asks come from the catalogue, minus what the customer said", () => {
  it("asks the sub-category's question", () => {
    expect(
      requirementForLead(
        lead({ service: "Carpet Cleaning Service", post_text: "Need my carpet cleaned" }),
      ),
    ).toBe("let me know the size and share a picture of the carpet area");
  });

  it("does not re-ask something already in the post", () => {
    const asks = requirementForLead(
      lead({ service: "Gutter Cleaning", post_text: "Clean the gutters on my two story house" }),
    );
    expect(asks).not.toMatch(/single or double story/);
  });

  it("does not re-ask something already in a saved CS note", () => {
    const asks = requirementForLead(
      lead({
        service: "Gutter Cleaning",
        post_text: "Need the gutters cleaned",
        cs_notes: [{ text: "Customer says it is a two story house" }],
      }),
    );
    expect(asks).not.toMatch(/single or double story/);
  });
  it.each(["main_area", "sub_area"] as const)("does not re-ask an address saved in %s", (field) => {
    const asks = requirementForLead(
      lead({
        service: "Gutter Cleaning",
        post_text: "Need the gutters cleaned",
        [field]: "123 Example Street, Denver, CO",
      }),
    );
    expect(asks).not.toMatch(/address/i);
  });
  it("does not resurrect answered questions through a stored or generic fallback", () => {
    const known = lead({
      service: "Gutter Cleaning",
      post_text:
        "Clean the gutters on my two story house tomorrow. I sent photos. Each gutter run is 20 feet.",
      cs_notes: [{ text: "Address on file" }],
      requirement_1: "share your complete address",
    });
    expect(requirementForLead(known)).toBe("");
    const message = renderCsComposeSuggestion(SCHEDULE, known);
    expect(message).not.toMatch(/kindly|schedule|\(Requirement\)|address|\?/i);
    expect(message).toContain("looking for a gutter cleaning service.");
  });
  it("acknowledges a completed job without a new scheduling question", () => {
    const message = renderCsComposeSuggestion(
      SCHEDULE,
      lead({
        post_text: "The repair is done. I do not need any more help.",
        service: "Handyman",
      }),
    );
    expect(message).toContain("no further service is needed");
    expect(message).not.toMatch(/looking for|schedule|kindly|\?/);
  });

  it("elides a repeated leading verb, as the delivered messages do", () => {
    expect(
      requirementForLead(
        lead({ service: "Carpet Cleaning Service", post_text: "Carpet cleaning please" }),
      ),
    ).not.toMatch(/share .* and share /);
  });

  it("uses the stored requirements only when the catalogue has no sources", () => {
    expect(
      requirementForLead(
        lead({
          post_text: null,
          context: null,
          requirement_1: "share a picture of the hot tub",
          requirement_2: "share your complete address",
        }),
      ),
    ).toBe("share a picture of the hot tub and your complete address");
  });

  it("falls back to the team's own scope-and-address pair, never to nothing", () => {
    expect(requirementForLead(lead({}))).toBe(
      "let me know what exactly needs to be done and share your complete address",
    );
  });
});

describe("firstName", () => {
  it.each([
    ["Casey Test", "Casey"],
    ["  Amy  Brown ", "Amy"],
    [null, "there"],
    ["", "there"],
  ])("%s -> %s", (input, expected) => {
    expect(firstName(input)).toBe(expected);
  });
});
