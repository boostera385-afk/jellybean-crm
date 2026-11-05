import { describe, expect, it } from "vitest";
import { polishComposedMessage } from "../../supabase/functions/_shared/cs-compose-polish";

describe("polishing a composed first reply", () => {
  it.each([
    [
      "Could you kindly share picture of the repair area  and your complete address, so I can check the schedule for a visit?",
      "Could you kindly share a picture of the repair area and your complete address, so I can check the schedule for a visit?",
    ],
    [
      "Could you kindly share a picture of where you want to install the lights and let me know do you already have the lights, so I can check the schedule for a visit?",
      "Could you kindly share a picture of where you want to install the lights and let me know if you already have the lights, so I can check the schedule for a visit?",
    ],
    [
      "Could you kindly let me know if your house is single or double story and do you need cleaning for specific area or full house, so I can check the schedule for a visit?",
      "Could you kindly let me know if your house is single or double story and if you need cleaning for specific area or full house, so I can check the schedule for a visit?",
    ],
    [
      "I saw that you are looking for a christmas lights installation service.",
      "I saw that you are looking for a Christmas lights installation service.",
    ],
    [
      "I saw that you are looking for a panasonic microwave repair service.",
      "I saw that you are looking for a Panasonic microwave repair service.",
    ],
    [
      "Could you kindly let me know what the issue you facing with dryer and share the brand name of the dryer, so I can check the schedule for a visit?",
      "Could you kindly let me know what issue you are facing with your dryer and share the brand name of the dryer, so I can check the schedule for a visit?",
    ],
    [
      "I saw that you are looking for a refrigerator repair service as its stopped cooling.",
      "I saw that you are looking for a refrigerator repair service as it has stopped cooling.",
    ],
    [
      "I saw that you are looking for a Kenmoore refrigerator repair service that are suddenly stopped freezing.",
      "I saw that you are looking for a Kenmoore refrigerator repair service that suddenly stopped freezing.",
    ],
    [
      "share a picture of the house where the lights needs to be installed",
      "share a picture of the house where the lights need to be installed",
    ],
    [
      "I saw that you are looking for a handyman service for flooring replacement, painting, and sheetrock installation service.",
      "I saw that you are looking for a handyman service for flooring replacement, painting, and sheetrock installation.",
    ],
    [
      "Could you kindly share the size of the door and and picture of it, so I can check the schedule for a visit?",
      "Could you kindly share the size of the door and a picture of it, so I can check the schedule for a visit?",
    ],
  ])("fixes %j", (draft, expected) => {
    expect(polishComposedMessage(draft)).toBe(expected);
  });

  it("leaves a correct draft exactly as it is", () => {
    const draft =
      "Hi Megan, this is Harrison. I saw that you are looking for a house painting service. Could you kindly let me know the size of the area that needs to be painted and share pictures of it, so I can check the schedule for a visit?";
    expect(polishComposedMessage(draft)).toBe(draft);
  });

  it("does not touch names or words that only look like brands", () => {
    const draft =
      "Hi Ge, this is Ben. I saw that you are looking for a mail carrier box installation.";
    expect(polishComposedMessage(draft)).toBe(draft);
  });

  it("never changes the customer's own spelling of a brand", () => {
    expect(polishComposedMessage("a Kenmoore refrigerator repair service")).toBe(
      "a Kenmoore refrigerator repair service",
    );
  });
});
