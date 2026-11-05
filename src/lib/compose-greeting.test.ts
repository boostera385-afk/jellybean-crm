import { describe, expect, it } from "vitest";
import { greetedName, greetingNameMismatch } from "./compose-greeting";

describe("greeting name check", () => {
  it.each([
    ["Hi Graciela, we had a conversation on Nextdoor regarding moving service.", "George Stuhi"],
    [
      "Hi Jacob, this is Brian. I saw that you are looking for a hot tub moving service.",
      "Diana Lewis",
    ],
    ["Hi Brenda, this is George.", "Brandon Dalewalker"],
    ["Hi Anteya, this is Steve.", "Janteya Gibson"],
  ])("flags %j for %s", (draft, customer) => {
    expect(greetingNameMismatch(draft, customer)).not.toBeNull();
  });

  it.each([
    ["Hi Steven, this is Arthur.", "Steven.. Mastrolia"],
    ["Hi Jo Ann, this is Floyd.", "Jo-Ann Ferro"],
    ["Hi Terri, this is Francis.", "Terri-Lynn McCormick"],
    ["Hi Liz, this is Walter.", "Liset (Liz) Ruiz"],
    ["Hi Beth, this is Jacob.", "John & Beth Montemagno"],
    ["Hi Thaddeus and Gloria, this is Ben.", "Thaddeus & Gloria Orozco"],
    ["Hi Maureen This is Alex", "Maureen Pfund"],
    ["Hi there, this is Gavin.", "Leo/Silva Vergel"],
    ["Hi, this is Arthur.", "Customer Need: Needs a person to wash solar panels"],
    ["Hi Inderjit, this is Raymond.", "Fnu Inderjit Singh"],
    ["", "Anyone"],
    ["Please call me back", "Anyone"],
  ])("accepts %j for %s", (draft, customer) => {
    expect(greetingNameMismatch(draft, customer)).toBeNull();
  });

  it("reads the greeted name up to the comma or the introduction", () => {
    expect(greetedName("Hi Maureen This is Alex")).toBe("Maureen");
    expect(greetedName("Hello Sam, we had a conversation")).toBe("Sam");
  });
});
