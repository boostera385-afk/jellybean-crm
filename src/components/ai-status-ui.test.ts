import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("urgent CS/Crisp UI contracts", () => {
  it("filters important leads on the server for both listing and pagination", () => {
    const source = readFileSync("src/routes/app.cs-leads.tsx", "utf8");
    expect(source).toContain("IMP LEADS");
    expect(source).not.toContain("garageDoorOnly");
    expect(source.match(/if \(importantOnly\) q = q\.eq\("is_important", true\)/g)).toHaveLength(2);
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
});
