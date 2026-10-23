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
  it("reads the window start and the not-contacted count when the report has them", () => {
    const scoped = { ...report, untouched: 3, scopeStart: "2026-10-18T09:00:00Z" };
    expect(parseAiStatusReport(scoped)).toEqual(scoped);
  });
  it.each([
    null,
    {},
    { ...report, counts: { converted: -1 } },
    { ...report, total: "10" },
    { ...report, lastAnalyzedAt: "invalid" },
    { ...report, untouched: -1 },
    { ...report, untouched: "3" },
    { ...report, scopeStart: "not a date" },
  ])("does not render failed reports as zeros", (value) => {
    expect(() => parseAiStatusReport(value)).toThrow();
  });
});
