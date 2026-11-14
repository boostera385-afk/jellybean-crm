import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/** Keyboard navigation works on the currently rendered (expanded) tree only. */
export function TreeView({ children, label }: { children: ReactNode; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rows = root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
    if (rows?.length && !Array.from(rows).some((row) => row.tabIndex === 0)) rows[0].tabIndex = 0;
  }, [children]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!current || !root.current) return;
    const rows = Array.from(root.current.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const index = rows.indexOf(current);
    let target: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        target = rows[Math.min(index + 1, rows.length - 1)];
        break;
      case "ArrowUp":
        target = rows[Math.max(index - 1, 0)];
        break;
      case "Home":
        target = rows[0];
        break;
      case "End":
        target = rows[rows.length - 1];
        break;
      case "ArrowRight":
        if (current.getAttribute("aria-expanded") === "false")
          current.querySelector<HTMLButtonElement>("[data-tree-toggle]")?.click();
        else if (
          current.getAttribute("aria-expanded") === "true" &&
          Number(rows[index + 1]?.getAttribute("aria-level")) >
            Number(current.getAttribute("aria-level"))
        )
          target = rows[index + 1];
        break;
      case "ArrowLeft":
        if (current.getAttribute("aria-expanded") === "true")
          current.querySelector<HTMLButtonElement>("[data-tree-toggle]")?.click();
        else target = current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined;
        break;
      case "Enter":
      case " ":
        current.querySelector<HTMLElement>("[data-tree-select]")?.click();
        break;
      default:
        return;
    }
    event.preventDefault();
    target?.focus();
  }
  return (
    <div
      ref={root}
      role="tree"
      aria-label={label}
      onKeyDown={onKeyDown}
      onFocusCapture={(event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
        if (!target) return;
        root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]').forEach((row) => {
          row.tabIndex = row === target ? 0 : -1;
        });
      }}
      className="space-y-1"
    >
      {children}
    </div>
  );
}
