import { describe, expect, it } from "vitest";
import { reviewReason } from "./review-reason";

describe("reviewReason", () => {
  it("returns nothing without a reason", () => {
    expect(reviewReason(null)).toBeNull();
    expect(reviewReason("  ")).toBeNull();
  });

  it("maps known codes to a short label", () => {
    expect(reviewReason("ambiguous_conversation")?.short).toBe("Unclear reply");
    expect(reviewReason("delivery_not_confirmed")?.short).toBe("Not delivered yet");
  });

  it("groups AI and Quo failures", () => {
    expect(reviewReason("model_unavailable")?.short).toBe("AI error");
    expect(reviewReason("quo_rate_limited")?.short).toBe("Quo error");
  });

  it("keeps unknown codes short", () => {
    const r = reviewReason("some_brand_new_reason_code_that_is_long");
    expect(r?.short.length).toBeLessThanOrEqual(22);
    expect(r?.detail).toContain("some brand new reason code that is long");
    expect(r?.action).toBeTruthy();
  });
});
