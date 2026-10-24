import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("urgent CS/Crisp UI contracts", () => {
  it("filters important leads on the server for both listing and pagination", () => {
    const source = readFileSync("src/routes/app.cs-leads.tsx", "utf8");
    expect(source).toContain("IMP LEADS");
    expect(source).not.toContain("garageDoorOnly");
    // Listing filters in the query itself; pagination's total now comes from
    // cs_leads_status_counts_filtered, which applies the same predicate
    // server-side, so the exact count(*) that carried the second copy is gone.
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
  it("keeps AI counts separate, unavailable counts unknown, and refresh bounded", () => {
    const source = readFileSync("src/routes/app.reports.tsx", "utf8");
    expect(source).toContain("Comparison only");
    expect(source).toContain("Refresh AI · next 5 leads");
    expect(source).toContain('aiValue === null ? "—"');
    expect(source.replace(/\s+/g, " ")).toContain("A disagreement is not proof that AI is correct");
  });
  it("shows AI tag suggestions to admins only and applies them through Save", () => {
    const route = readFileSync("src/routes/app.cs-leads.tsx", "utf8");
    // Data fetch is skipped for non-admins, not merely hidden in CSS.
    expect(route).toContain("lead_ai_status");
    expect(route).toContain("enabled: isAdmin");
    // Card chip stays visually distinct from manual status tags.
    expect(route).toContain("border-dashed border-violet-400/70");
    // Drawer panel explains itself and never writes statuses directly.
    expect(route).toContain("AI tag suggestion");
    expect(route).toContain("Comparison only — not saved");
    expect(route).toContain("Use this tag");
    expect(route).toContain("AI suggestion selected — press Save to apply");
    expect(route).toContain("AI never changes saved statuses automatically.");
    // Applying a suggestion only pre-fills the drawer status; it must not
    // call .update({ cs_status ... }) from the AI panel code path.
    expect(route).not.toContain("onUse={() =>");
    const migration = readFileSync(
      "supabase/migrations/20261021104500_admin_only_lead_ai_status.sql",
      "utf8",
    );
    expect(migration).toContain('DROP POLICY IF EXISTS "AI results follow lead access"');
    expect(migration).toContain('CREATE POLICY "AI suggestions for reporting administrators"');
    expect(migration).toContain("current_user_has_role_text('admin')");
    expect(migration).toContain("FOR SELECT");
  });
});
