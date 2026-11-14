import { useState } from "react";
import { ChevronRight, Network } from "lucide-react";
import { useExplorerQuery } from "@/hooks/use-lead-explorer";
import {
  branchId,
  branchLabel,
  type ExplorerFilters,
  type ExplorerGroup,
} from "@/lib/lead-explorer";
import { friendlyError } from "@/lib/error-messages";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TreeView } from "./tree-view";

type Props = {
  group: ExplorerGroup;
  path: string[];
  filters: ExplorerFilters;
  expanded: Set<string>;
  toggle: (path: string[]) => void;
  select: (path: string[]) => void;
  total: number | undefined;
};

const VISIBLE_CHILDREN = 12;
// One accent per depth keeps levels distinguishable in light and dark themes.
const DEPTH_ACCENT = [
  "border-l-primary",
  "border-l-sky-500",
  "border-l-emerald-500",
  "border-l-amber-500",
];
// Child rows draw their own connector: a vertical rail plus a horizontal stub.
const CONNECTOR =
  "relative pb-2 last:pb-0 before:absolute before:-left-6 before:top-0 before:bottom-0 before:w-px before:bg-border " +
  "first:before:top-5 last:before:bottom-auto last:before:h-5 only:before:hidden " +
  "after:absolute after:-left-6 after:top-5 after:h-px after:w-6 after:bg-border";

/** Left-to-right decision-tree style diagram of the same lazy, RLS-scoped branches. */
export function ExplorerDiagram(props: Props & { collapse: () => void }) {
  const rootSelected = props.path.length === 0;
  return (
    <section className="crm-section-panel min-w-0" aria-label="Lead hierarchy diagram">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="crm-section-title !text-sm">
          <Network className="h-4 w-4" /> Hierarchy diagram
        </h2>
        <Button variant="ghost" size="sm" onClick={props.collapse}>
          Collapse all
        </Button>
      </div>
      <div className="overflow-auto pb-2" tabIndex={-1}>
        <TreeView label={props.group === "area" ? "Leads by area" : "Leads by service"}>
          <div
            role="treeitem"
            aria-level={1}
            aria-expanded
            aria-selected={rootSelected}
            aria-label={`All qualified leads, ${props.total ?? "loading"} leads`}
            tabIndex={-1}
            className="flex w-max items-start rounded-lg outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <button
              type="button"
              tabIndex={-1}
              data-tree-select
              onClick={() => props.select([])}
              className={cn(
                "flex h-10 w-56 shrink-0 items-center gap-2 rounded-lg border border-l-4 border-border bg-card px-3 text-left text-sm font-semibold shadow-sm transition-colors hover:bg-accent/50 motion-reduce:transition-none",
                DEPTH_ACCENT[0],
                rootSelected && "bg-primary/10 ring-1 ring-primary/30",
              )}
            >
              <span className="min-w-0 flex-1 truncate">All qualified leads</span>
              <span className="crm-pill-text shrink-0 rounded-full bg-muted px-2 py-0.5 tabular-nums text-muted-foreground">
                {props.total === undefined ? "—" : props.total.toLocaleString()}
              </span>
            </button>
            <div role="group" className="animate-fade-in relative ml-6 pl-6">
              <span aria-hidden="true" className="absolute -left-6 top-5 h-px w-6 bg-border" />
              <DiagramLevel {...props} parent={[]} />
            </div>
          </div>
        </TreeView>
      </div>
    </section>
  );
}

function DiagramLevel(props: Props & { parent: string[] }) {
  const [showAll, setShowAll] = useState(false);
  const query = useExplorerQuery("nodes", props.group, props.parent, props.filters);
  if (query.isPending) return <DiagramLoading />;
  if (query.isError)
    return (
      <div role="alert" className="w-56 space-y-1 text-xs text-muted-foreground">
        <p>{friendlyError(query.error)}</p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry branches
        </Button>
      </div>
    );
  const nodes = query.data?.action === "nodes" ? query.data.value : [];
  if (!nodes.length) return <p className="w-56 text-xs text-muted-foreground">No branches</p>;
  const largest = Math.max(1, ...nodes.map((node) => node.total));
  const maxDepth = props.group === "area" ? 3 : 2;
  const depth = props.parent.length;
  const visible = showAll ? nodes : nodes.slice(0, VISIBLE_CHILDREN);
  return (
    <>
      {visible.map((node) => {
        const path = [...props.parent, node.key];
        const expandable = path.length < maxDepth;
        const expanded = props.expanded.has(branchId(props.group, path));
        const selected = branchId(props.group, path) === branchId(props.group, props.path);
        const label = branchLabel(props.group, depth, node.key);
        return (
          <div
            key={node.key}
            role="treeitem"
            aria-label={`${label}, ${node.total} leads`}
            aria-level={path.length + 1}
            aria-expanded={expandable ? expanded : undefined}
            aria-selected={selected}
            tabIndex={-1}
            className={cn(CONNECTOR, "flex w-max items-start outline-offset-2")}
          >
            <div
              className={cn(
                "relative flex h-10 w-56 shrink-0 items-center overflow-hidden rounded-lg border border-l-4 border-border bg-card text-sm shadow-sm transition-colors motion-reduce:transition-none hover:bg-accent/50",
                DEPTH_ACCENT[Math.min(depth + 1, DEPTH_ACCENT.length - 1)],
                selected && "bg-primary/10 ring-1 ring-primary/30",
              )}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary/40 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${Math.max(2, (node.total / largest) * 100)}%` }}
              />
              <button
                type="button"
                tabIndex={-1}
                data-tree-select
                onClick={() => props.select(path)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate" title={label}>
                  {label}
                </span>
                {node.new_count > 0 && (
                  <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                    {node.new_count} new
                  </span>
                )}
                <span className="crm-pill-text shrink-0 rounded-full bg-muted px-2 py-0.5 tabular-nums text-muted-foreground">
                  {node.total.toLocaleString()}
                </span>
              </button>
              {expandable ? (
                <button
                  type="button"
                  tabIndex={-1}
                  data-tree-toggle
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
                  className="grid h-full w-8 shrink-0 place-items-center hover:bg-accent"
                  onClick={() => props.toggle(path)}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 transition-transform motion-reduce:transition-none",
                      expanded && "rotate-90",
                    )}
                  />
                </button>
              ) : (
                <span className="w-2 shrink-0" />
              )}
            </div>
            {expandable && expanded && (
              <div role="group" className="animate-fade-in relative ml-6 pl-6">
                <span aria-hidden="true" className="absolute -left-6 top-5 h-px w-6 bg-border" />
                <DiagramLevel {...props} parent={path} />
              </div>
            )}
          </div>
        );
      })}
      {nodes.length > VISIBLE_CHILDREN && (
        <div className={cn(CONNECTOR, "w-56")}>
          <Button
            size="sm"
            variant="outline"
            className="h-10 w-full"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${nodes.length.toLocaleString()} branches`}
          </Button>
        </div>
      )}
    </>
  );
}

function DiagramLoading() {
  return (
    <div role="status" aria-label="Loading branches" className="w-56 space-y-2">
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-10 w-full" />
      ))}
    </div>
  );
}
