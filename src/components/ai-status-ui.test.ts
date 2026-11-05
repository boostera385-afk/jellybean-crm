import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("urgent CS/Crisp UI contracts", () => {
  it("filters important leads on the server for both listing and pagination", () => {
    const source = readFileSync("src/routes/app.cs-leads.tsx", "utf8");
    expect(source).toContain("IMP LEADS");
    expect(source).not.toContain("garageDoorOnly");
    // One copy of the listing filters (applyListFilters), shared by the rows and
    // by CS agents' page count; everyone else's pagination total comes from
    // cs_leads_status_counts_filtered, which applies the same predicate.
    expect(source.match(/if \(importantOnly\) q = q\.eq\("is_important", true\)/g)).toHaveLength(1);
    expect(source).toContain("p_important: importantOnly");
    expect(source).toContain('if (!importantOnly) setActiveStatus("__all__")');
  });
  it("distinguishes customer replies from live-only visitors without clearing unread state", () => {
    const source = readFileSync("src/routes/app.crisp-chat.tsx", "utf8");
    expect(source).toContain("CUSTOMER REPLIED");
    expect(source).toContain('isUnread\n                          ? "bg-amber-100');
    expect(source).toContain("Opening/viewing a chat must NOT clear");
    expect(source).toContain("flex-1 flex flex-col bg-background min-w-0");
  });
  it("explains AI automation, keeps unavailable counts unknown, and refresh scoped", () => {
    const source = readFileSync("src/routes/app.reports.tsx", "utf8");
    expect(source).toContain("AI status · Pipeline automation");
    expect(source).toContain("Refresh AI · selected range");
    expect(source).toContain('aiValue === null ? "—"');
    expect(source.replace(/\s+/g, " ")).toContain("A disagreement is not proof that AI is correct");
  });
  it("shows live AI provenance and a Needs Review queue while keeping evidence admin-only", () => {
    const route = readFileSync("src/routes/app.cs-leads.tsx", "utf8");
    // Detailed model evidence is skipped for non-admins, not merely hidden in CSS.
    expect(route).toContain("lead_ai_status");
    expect(route).toContain("enabled: isAdmin");
    expect(route).toContain('setActiveStatus("__needs_review__")');
    expect(route).toContain("cs_status_updated_by_ai");
    expect(route).toContain("ai_review_required");
    expect(route).toContain("AI updated status");
    expect(route).toContain("A manual status change replaces it");
    // Who set the status by hand, and the full status history pop-up.
    expect(route).toContain("cs_status_updated_by_name");
    expect(route).toContain('from("lead_status_history")');
    expect(route).toContain("Set Delivered manually once");
    expect(route).not.toContain("Comparison only — not saved");
    const migration = readFileSync(
      "supabase/migrations/20261104092301_cs_pipeline_ai_status_automation.sql",
      "utf8",
    );
    expect(migration).toContain("ai_status_automation_started_at");
    expect(migration).toContain("cs_status_updated_by_ai = true");
    expect(migration).toContain("ai_review_required = true");
    expect(migration).toContain("q.cs_status_human_updated_at > r.started_at");
  });
});
