import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

/** Comments mention z-indexes in prose, so strip them before reading classes. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Highest z-index applied to an element in this file. */
function topZ(path: string): number {
  // No trailing \b after the bracket form: "]" and the following space are
  // both non-word characters, so a boundary never matches there.
  const matches = [...stripComments(read(path)).matchAll(/\bz-(?:\[(\d+)\]|(\d+)\b)/g)];
  const values = matches.map((match) => Number(match[1] ?? match[2]));
  expect(values.length, `no z-index found in ${path}`).toBeGreaterThan(0);
  return Math.max(...values);
}

/**
 * The layering contract.
 *
 * A live-visitor card was rendering at z-[95], above every dialog, so a
 * visitor going live covered the buttons of whatever record was open. These
 * bands keep that from coming back: an ambient notification can never outrank
 * a dialog, and a control that has to open inside a dialog must outrank it.
 */
describe("overlay layering", () => {
  const ambient = topZ("components/crisp-visitor-alerts.tsx");
  const dialog = topZ("components/ui/dialog.tsx");
  const sheet = topZ("components/ui/sheet.tsx");
  const alertDialog = topZ("components/ui/alert-dialog.tsx");

  it("keeps ambient visitor cards below every dialog surface", () => {
    expect(ambient).toBeLessThan(dialog);
    expect(ambient).toBeLessThan(sheet);
    expect(ambient).toBeLessThan(alertDialog);
  });

  it("keeps ambient visitor cards above ordinary page content", () => {
    // Page chrome such as the sticky mobile header sits at z-30.
    expect(ambient).toBeGreaterThan(30);
  });

  it("keeps the dialog layer consistent across dialog, sheet and alert-dialog", () => {
    expect(sheet).toBe(dialog);
    expect(alertDialog).toBe(dialog);
  });

  it.each([
    ["state-combobox", "components/state-combobox.tsx"],
    ["service-combobox", "components/service-combobox.tsx"],
    ["service-assignment-tab", "components/service-assignment-tab.tsx"],
  ])("keeps %s poppers above the dialog they open inside", (_name, path) => {
    expect(topZ(path)).toBeGreaterThan(dialog);
  });

  it("leaves the message notifier on top, since it is a modal interrupt", () => {
    // Full-screen overlay with its own backdrop and explicit Dismiss actions:
    // unlike the visitor cards, it is meant to block.
    expect(topZ("components/crisp-message-notifier.tsx")).toBeGreaterThan(dialog);
  });
});
