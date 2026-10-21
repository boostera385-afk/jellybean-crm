import { describe, expect, it } from "vitest";
import { parseAiStatusReport } from "./ai-status-report";

describe("AI report counts", () => {
  const report = {
    counts: { converted: 5 },
    total: 10,
    classified: 5,
    disagreements: 2,
    review: 1,
    stale: 0,
    lastAnalyzedAt: null,
  };
  it("keeps manual cohort size separate from AI coverage", () => {
    expect(parseAiStatusReport(report)).toEqual(report);
  });
  it.each([
    null,
    {},
    { ...report, counts: { converted: -1 } },
    { ...report, total: "10" },
    { ...report, lastAnalyzedAt: "invalid" },
  ])("does not render failed reports as zeros", (value) => {
    expect(() => parseAiStatusReport(value)).toThrow();
  });
});
