import { describe, expect, it } from "vitest";
import {
  NUMBER_NAMES,
  formatInboxPhone,
  inboxKeys,
  numberNameLabel,
  numberNamePhone,
  quoNameKey,
} from "../../supabase/functions/_shared/quo-number-names";
import { NUMBER_NAME_OPTIONS } from "@/components/number-name-select";

describe("the lead card's inbox list", () => {
  it("keeps the saved names exactly as they were", () => {
    // Every lead saved before the numbers were added still names an option.
    expect(NUMBER_NAME_OPTIONS).toHaveLength(38);
    expect(NUMBER_NAME_OPTIONS).toContain("Houston Handyman OP1");
    expect(NUMBER_NAME_OPTIONS).toContain("LOS ANGELES GARAGE DOOR / CLEANING / PLUMBING");
  });

  it("gives each known inbox one well-formed number, and no two share one", () => {
    const phones = NUMBER_NAMES.map((entry) => entry.phone).filter(Boolean);
    expect(phones.length).toBeGreaterThan(25);
    for (const phone of phones) expect(phone).toMatch(/^\+1\d{10}$/);
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("shows the number beside the name, and just the name when it is unknown", () => {
    expect(numberNameLabel("Houston Handyman OP1")).toBe("Houston Handyman OP1 · (281) 942-6479");
    expect(numberNameLabel("JOC HOT TUB")).toBe("JOC HOT TUB");
    expect(numberNameLabel(null)).toBe("");
    expect(formatInboxPhone("+12819426479")).toBe("(281) 942-6479");
    expect(numberNamePhone("houston handyman op1")).toBe("+12819426479");
  });
});

describe("which Quo inbox a saved name means", () => {
  it("finds an inbox Quo has renamed, by its number", () => {
    // Quo added "(HOLD OUTBOUND)"; the lead card still says "Dallas Garage Door".
    const keys = inboxKeys([
      { id: "PNdallas", name: "Dallas Garage Door (HOLD OUTBOUND)", number: "+1 (469) 718-8444" },
    ]);
    expect(keys[quoNameKey("Dallas Garage Door")]).toBe("PNdallas");
  });

  it("trusts the number over a name that happens to match another inbox", () => {
    const keys = inboxKeys([
      { id: "PNwrong", name: "Houston Handyman OP1", number: "+15550000000" },
      { id: "PNright", name: "Houston OP1 (new name)", number: "+12819426479" },
    ]);
    expect(keys[quoNameKey("Houston Handyman OP1")]).toBe("PNright");
  });

  it("falls back to the Quo name for an option whose number is not known", () => {
    const keys = inboxKeys([{ id: "PNjoc", name: "JOC HOT TUB", number: "+15551112222" }]);
    expect(keys[quoNameKey("JOC HOT TUB")]).toBe("PNjoc");
  });

  it("maps nothing for a name no inbox answers to", () => {
    const keys = inboxKeys([{ id: "PN1", name: "Somewhere Else", number: "+15551112222" }]);
    expect(keys[quoNameKey("Max Mad")]).toBeUndefined();
  });
});
