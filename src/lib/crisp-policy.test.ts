import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  eventFingerprint,
  mapConcurrent,
  sendOutcome,
  timingSafeEqual,
} from "../../supabase/functions/_shared/crisp-policy";

describe("Crisp reliable processing policy", () => {
  it("never blindly retries an ambiguous external send", () => {
    expect(sendOutcome(null)).toBe("uncertain");
    expect(sendOutcome(502)).toBe("uncertain");
    expect(sendOutcome(408)).toBe("uncertain");
    expect(sendOutcome(429)).toBe("retry");
    expect(sendOutcome(420)).toBe("retry");
    expect(sendOutcome(401)).toBe("failed");
    expect(sendOutcome(200)).toBe("sent");
  });
  it("deduplicates identical events regardless of JSON property order", async () => {
    expect(await eventFingerprint({ event: "test", data: { a: 1, b: 2 } })).toBe(
      await eventFingerprint({ data: { b: 2, a: 1 }, event: "test" }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it("checks exact secrets instead of trusting JWT claims", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual("secret", "secreT")).toBe(false);
    expect(timingSafeEqual("secret", "")).toBe(false);
  });
  it("bounds parallelism without losing work", async () => {
    let active = 0;
    let maximum = 0;
    const done: number[] = [];
    await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      done.push(n);
      active--;
    });
    expect(maximum).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
