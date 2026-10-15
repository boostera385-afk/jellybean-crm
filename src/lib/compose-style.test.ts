import { describe, expect, it } from "vitest";
import {
  buildComposeSystemPrompt,
  canonicalizeRequirement,
  requirementIntentKey,
  selectComposeExemplars,
  serviceKey,
} from "@/lib/compose-style";

describe("compose house style", () => {
  it("folds service name variants onto one key", () => {
    expect(serviceKey("General Handyman Service")).toBe("handyman");
    expect(serviceKey("handyman")).toBe("handyman");
    expect(serviceKey("Handyman")).toBe("handyman");
  });

  it("treats the same ask worded differently as one intent", () => {
    const k = requirementIntentKey("share your complete address");
    expect(requirementIntentKey("your complete address")).toBe(k);
    expect(requirementIntentKey("complete address")).toBe(k);
  });

  it.each([
    ["your complete address", "share your complete address"],
    ["complete address", "share your complete address"],
    ["Share your complete address.", "share your complete address"],
    ["share your availability", "let me know your availability"],
    ["share what exactly needs to be done", "let me know what exactly needs to be done"],
  ])("snaps %s onto the majority wording", (input, expected) => {
    expect(canonicalizeRequirement(input)).toBe(expected);
  });

  it("keeps a one-off requirement instead of flattening it", () => {
    // The old rules rewrote anything mentioning a picture to
    // "send me a picture of it", losing the object. Delivered messages always
    // name it, so specific wording must survive.
    const specific = "share a picture of the junk items";
    expect(canonicalizeRequirement(specific)).toContain("junk items");
    const longTail = "let me know if the garage spring is broken";
    expect(canonicalizeRequirement(longTail)).toBe(longTail);
  });

  it("never returns capitalised or punctuated requirements", () => {
    const out = canonicalizeRequirement("Share the size of the door.");
    expect(out[0]).toBe(out[0]?.toLowerCase());
    expect(out.endsWith(".")).toBe(false);
  });

  it("always offers exemplars, even for an unknown trade", () => {
    expect(selectComposeExemplars("Garage Door Repair", 3).length).toBeGreaterThan(0);
    expect(selectComposeExemplars("Totally Unknown Trade", 3).length).toBeGreaterThan(0);
    expect(selectComposeExemplars(null, 3).length).toBeGreaterThan(0);
  });

  it("builds a prompt that teaches the delivered style, not the old one", () => {
    const p = buildComposeSystemPrompt();
    // The old prompt banned the word "service" and asked for a bare name.
    expect(p).toContain("share your complete address");
    expect(p).not.toContain('Never use "service"');
    expect(p).toContain("serviceContext");
    expect(p).toContain("requirement1");
  });
});
