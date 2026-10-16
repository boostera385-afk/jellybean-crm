import { describe, it, expect } from "vitest";
import { normalizeAdjacentRequirements } from "./raw-leads-ai.functions";

// Each "got" pair is a real output pattern from the 2026-10-16 live test.
describe("normalizeAdjacentRequirements", () => {
  it("elides a repeated 'let me know' across the pair", () => {
    const [a, b] = normalizeAdjacentRequirements(
      "let me know what issue you are facing with the freezer",
      "let me know the size of the freezer",
    );
    expect(a).toBe("let me know what issue you are facing with the freezer");
    expect(b).toBe("the size of the freezer");
  });

  it("turns 'share X and share Y' into 'share X and Y'", () => {
    const [a, b] = normalizeAdjacentRequirements(
      "share a picture of the doors and shutters",
      "share your complete address",
    );
    expect(a).toBe("share a picture of the doors and shutters");
    expect(b).toBe("your complete address");
  });

  it("gives a verbless second ask a leading 'share'", () => {
    const [a, b] = normalizeAdjacentRequirements(
      "let me know the size of the drywall",
      "a picture of it",
    );
    expect(a).toBe("let me know the size of the drywall");
    expect(b).toBe("share a picture of it");
  });

  it("gives a verbless question-form ask a leading 'tell me'", () => {
    const [a, b] = normalizeAdjacentRequirements(
      "share your complete address",
      "what issue you are facing with the freezer",
    );
    expect(a).toBe("share your complete address");
    expect(b).toBe("tell me what issue you are facing with the freezer");
  });

  it("keeps different leading verbs untouched", () => {
    const [a, b] = normalizeAdjacentRequirements(
      "share your complete address",
      "let me know your preferred time window",
    );
    expect(a).toBe("share your complete address");
    expect(b).toBe("let me know your preferred time window");
  });

  it("passes through empty sides and single requirements unchanged", () => {
    expect(normalizeAdjacentRequirements("", "confirm the details")).toEqual([
      "",
      "confirm the details",
    ]);
    expect(normalizeAdjacentRequirements("share your complete address", "")).toEqual([
      "share your complete address",
      "",
    ]);
  });
});
