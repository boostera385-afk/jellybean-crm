import { describe, expect, it } from "vitest";
import { Constants } from "@/integrations/supabase/types";
import { pinnedImportantFor } from "@/lib/lead-statuses";

describe("persisted customer outcomes", () => {
  it.each(["cx_interested", "cx_not_interested", "cx_didnt_replied"] as const)(
    "supports %s as a distinct database outcome",
    (status) => {
      expect(Constants.public.Enums.cs_status).toContain(status);
      expect(status).not.toBe("converted");
    },
  );

  it("preserves existing delivered records under the converted identifier", () => {
    expect(Constants.public.Enums.cs_status).toContain("converted");
  });
});

describe("pinned important leads", () => {
  it("keeps the pin while the lead is still new", () => {
    expect(pinnedImportantFor(true, "new")).toBe(true);
  });

  it.each(["called", "messaged", "follow_up", "converted", "closed_lost", "out_of_base"])(
    "drops the pin once the status moves to %s",
    (status) => {
      expect(pinnedImportantFor(true, status)).toBe(false);
    },
  );

  it("never invents a pin for an unpinned lead", () => {
    expect(pinnedImportantFor(false, "new")).toBe(false);
    expect(pinnedImportantFor(null, "new")).toBe(false);
    expect(pinnedImportantFor(undefined, "new")).toBe(false);
  });

  it("treats a missing status as not new", () => {
    expect(pinnedImportantFor(true, null)).toBe(false);
    expect(pinnedImportantFor(true, undefined)).toBe(false);
  });
});
