import { describe, expect, it } from "vitest";
import { isAuthExpiredError } from "@/lib/auth-errors";

/**
 * The matcher must know every way `requireSupabaseAuth` rejects a session, or a
 * stale token keeps answering 500 and blanks the screen instead of asking the
 * user to sign in again.
 */
describe("isAuthExpiredError", () => {
  it.each([
    "Unauthorized: No request headers available",
    "Unauthorized: No authorization header provided",
    "Unauthorized: Only Bearer tokens are supported",
    "Unauthorized: No token provided",
    "Unauthorized: Invalid token",
    "Unauthorized: No user ID found in token",
  ])("recognises an expired session from %s", (message) => {
    expect(isAuthExpiredError(new Error(message))).toBe(true);
  });

  it("does not treat a database or role failure as an expired session", () => {
    expect(isAuthExpiredError(new Error("Could not verify user roles"))).toBe(false);
    expect(isAuthExpiredError(new Error("relation \"crisp_visitors\" does not exist"))).toBe(false);
    expect(isAuthExpiredError(new Error("Crisp request budget or cooldown reached"))).toBe(false);
  });

  it("ignores errors it cannot read", () => {
    expect(isAuthExpiredError(undefined)).toBe(false);
    expect(isAuthExpiredError(null)).toBe(false);
    expect(isAuthExpiredError({ message: "Unauthorized: Invalid token" })).toBe(false);
  });
});
