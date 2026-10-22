import { describe, expect, it } from "vitest";
import {
  COMPOSE_SENDER_NAMES,
  LEADS_PER_SENDER,
  fallbackTick,
  senderForTick,
} from "@/lib/compose-senders";

describe("compose sender rotation", () => {
  it("holds 200 distinct names", () => {
    expect(COMPOSE_SENDER_NAMES).toHaveLength(200);
    expect(new Set(COMPOSE_SENDER_NAMES).size).toBe(200);
  });

  it("carries no name that should have been retired", () => {
    // These went out to real customers and were dropped deliberately:
    // a public figure, two misspellings, typos, a fictional character,
    // initials, a bare surname and a one-off.
    for (const bad of [
      "Elon",
      "Buttler",
      "Nathen",
      "Altas",
      "aJoshua",
      "Jaoshua",
      "Reacher",
      "CJ",
      "Smith",
      "Saim",
    ]) {
      expect(COMPOSE_SENDER_NAMES).not.toContain(bad);
    }
  });

  it("holds every name for a run before switching", () => {
    const first = senderForTick(LEADS_PER_SENDER);
    for (let t = LEADS_PER_SENDER; t < LEADS_PER_SENDER * 2; t++) {
      expect(senderForTick(t)).toBe(first);
    }
    expect(senderForTick(LEADS_PER_SENDER * 2)).not.toBe(first);
  });

  it("uses every name once before repeating, then wraps", () => {
    const seen = new Set<string>();
    const cycle = COMPOSE_SENDER_NAMES.length * LEADS_PER_SENDER;
    for (let t = 0; t < cycle; t += LEADS_PER_SENDER) seen.add(senderForTick(t));
    expect(seen.size).toBe(COMPOSE_SENDER_NAMES.length);
    expect(senderForTick(cycle)).toBe(senderForTick(0));
  });

  it("never signs a message Alex unless the roster reaches Alex's slot", () => {
    // The old code defaulted to "Alex" for every message. Alex stays in the
    // roster, but may only appear at its own slot.
    const alexSlot = COMPOSE_SENDER_NAMES.indexOf("Alex");
    expect(alexSlot).toBeGreaterThan(0);
    expect(senderForTick(0)).not.toBe("Alex");
    expect(senderForTick(alexSlot * LEADS_PER_SENDER)).toBe("Alex");
  });

  it("returns a real name for unusable ticks instead of undefined", () => {
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY, -1, -9999]) {
      expect(COMPOSE_SENDER_NAMES).toContain(senderForTick(t));
    }
  });

  it("still varies when the shared counter is unreachable", () => {
    // The fallback must not pin every message to one name again.
    const names = new Set(
      [0, 3_600_000, 7_200_000, 86_400_000].map((t) => senderForTick(fallbackTick(t))),
    );
    expect(names.size).toBeGreaterThan(1);
  });
});
