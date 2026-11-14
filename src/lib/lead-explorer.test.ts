import { describe, expect, it } from "vitest";
import {
  branchId,
  branchKey,
  branchLabel,
  canExplore,
  explorerRequestSchema,
  explorerSearchSchema,
  filterPayload,
  locationPath,
  serviceCategoryKey,
} from "./lead-explorer";
import { findServiceCategory } from "./service-assignment";
import { SERVICE_CATEGORIES } from "../data/service-options";
import { readFileSync } from "node:fs";

describe("Lead Explorer", () => {
  it("preserves historical values and distinguishes missing values from literals", () => {
    expect(branchKey(null)).toBe("missing");
    expect(branchKey(" \t ")).toBe("missing");
    expect(branchKey("missing")).toBe("v:missing");
    expect(branchKey(" Houston, TX ")).toBe("v: Houston, TX ");
    expect(branchKey("O'Brien / North")).toBe("v:O'Brien / North");
  });
  it("provides all fallback labels and actual area labels", () => {
    expect(branchLabel("area", 0, "missing")).toBe("Unknown state");
    expect(branchLabel("area", 1, "missing")).toBe("Unspecified area");
    expect(branchLabel("area", 2, "missing")).toBe("Unspecified sub-area");
    expect(branchLabel("service", 0, "unmapped")).toBe("Unmapped services");
    expect(branchLabel("service", 0, "missing")).toBe("Unspecified service");
  });
  it("matches the existing catalog helper including normalized spacing and case", () => {
    for (const group of SERVICE_CATEGORIES) {
      for (const service of group.services) {
        const historical = `  ${service.toUpperCase().replaceAll(" ", "  ")}  `;
        expect(serviceCategoryKey(historical)).toBe(`v:${findServiceCategory(historical)}`);
      }
    }
    expect(serviceCategoryKey(null)).toBe("missing");
    expect(serviceCategoryKey("historical custom service")).toBe("unmapped");
    expect(serviceCategoryKey("constructor")).toBe("unmapped");
    expect(serviceCategoryKey("__proto__")).toBe("unmapped");
  });
  it("uses collision-safe path identities", () => {
    expect(branchId("area", ["v:A/B", "v:C"])).not.toBe(branchId("area", ["v:A", "v:B/C"]));
  });
  it("allows only the new module roles, not other roles", () => {
    for (const role of ["admin", "cs_admin", "cs"] as const) expect(canExplore(role)).toBe(true);
    for (const role of [
      "sub_admin",
      "scraping",
      "maturing",
      "facebook",
      "seo",
      "fb_admin",
      "acc_handler",
    ] as const)
      expect(canExplore(role)).toBe(false);
    expect(canExplore(null)).toBe(false);
  });
  it("does not retain query or other personal data in URL state", () => {
    const value = explorerSearchSchema.parse({
      query: "personal",
      q: "phone",
      group: "service",
      path: ["v:A", "v:B", "v:C"],
    });
    expect(value.path).toHaveLength(2);
    expect(value).not.toHaveProperty("query");
    expect(value).not.toHaveProperty("q");
    expect(explorerSearchSchema.parse({ group: "bad", leadId: "bad" }).group).toBe("area");
  });
  it("validates dates, branches and cursor boundaries", () => {
    const base = { action: "results", group: "area", path: [], filters: {} };
    expect(explorerRequestSchema.safeParse(base).success).toBe(true);
    expect(explorerRequestSchema.safeParse({ ...base, path: ["unprefixed"] }).success).toBe(false);
    expect(
      explorerRequestSchema.safeParse({ ...base, group: "service", path: ["v:A", "v:B", "v:C"] })
        .success,
    ).toBe(false);
    expect(
      explorerRequestSchema.safeParse({
        ...base,
        filters: { from: "2026-11-15", to: "2026-11-14" },
      }).success,
    ).toBe(false);
    expect(explorerRequestSchema.safeParse({ ...base, action: "detail" }).success).toBe(false);
  });
  it("uses inclusive PKT dates and exclusive UTC end boundary", () => {
    expect(
      filterPayload({
        query: "O'Brien_%\\",
        from: "2026-11-14",
        to: "2026-11-14",
        owner: "all",
        important: false,
        due: false,
      }),
    ).toMatchObject({
      query: "O'Brien_%\\",
      date_from: "2026-11-13T19:00:00.000Z",
      date_to: "2026-11-14T19:00:00.000Z",
    });
  });
  it("shows the full location path including missing ancestors", () => {
    expect(locationPath({ state_code: null, main_area: "North", sub_area: null })).toBe(
      "Unknown state › North › Unspecified sub-area",
    );
  });
  it("keeps the module isolated from other roles and shares existing realtime", () => {
    const nav = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
    expect(nav).toContain('item.to !== "/app/lead-explorer"');
    expect(nav.match(/LEAD_EXPLORER_ITEM,/g)).toHaveLength(3);
    const realtime = readFileSync(
      new URL("../hooks/use-realtime-sync.ts", import.meta.url),
      "utf8",
    );
    expect(realtime).toContain('["lead-explorer"]');
    expect(realtime).toContain("makeDebouncedInvalidator(qc, 400)");
    const route = readFileSync(new URL("../routes/app.lead-explorer.tsx", import.meta.url), "utf8");
    expect(route).toContain("allow={EXPLORER_ROLES}");
    expect(route).toContain("canExplore(auth.primaryRole)");
    const functions = readFileSync(
      new URL("./lead-explorer.functions.ts", import.meta.url),
      "utf8",
    );
    expect(functions).toContain(".middleware([requireSupabaseAuth])");
    expect(functions).toContain(".inputValidator(explorerRequestSchema)");
    expect(functions).not.toContain("supabaseAdmin");
  });
});
