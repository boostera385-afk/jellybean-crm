import { describe, expect, it } from "vitest";
import {
  CRISP_FIRST_GREETING,
  CRISP_REVISIT_GREETING,
  validateCrispGreeting,
} from "./crisp-greeting-policy";

describe("compact visitor greeting policy", () => {
  it("keeps both defaults short and name-free", () => {
    for (const text of [CRISP_FIRST_GREETING, CRISP_REVISIT_GREETING]) {
      expect(text.length).toBeLessThanOrEqual(40);
      expect(() => validateCrispGreeting(text, "Greeting")).not.toThrow();
    }
  });
  it("rejects oversized messages, including disabled revisit drafts", () => {
    expect(() => validateCrispGreeting("a".repeat(121), "Revisit greeting")).toThrow(
      "120 characters",
    );
    expect(() => validateCrispGreeting("a".repeat(120), "Greeting")).not.toThrow();
  });
  it("rejects unverified name placeholders with arbitrary case and spaces", () => {
    for (const text of ["Hi {{name}}", "Hi {{ NAME }}"]) {
      expect(() => validateCrispGreeting(text, "Greeting")).toThrow("not verified real names");
    }
  });
});
