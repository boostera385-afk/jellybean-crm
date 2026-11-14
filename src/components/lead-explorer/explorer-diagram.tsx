import { useState } from "react";
import { ChevronDown, Network } from "lucide-react";
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

const VISIBLE_CHILDREN = 8;
// One accent per depth keeps levels distinguishable in light and dark themes.
const DEPTH_ACCENT = [
  "border-t-primary",
  "border-t-sky-500",
  "border-t-emerald-500",
  "border-t-amber-500",
];
// Top-down org-chart connectors: each child draws a rail segment to both neighbours
// plus a drop line to its own card. First/last/only children trim the rail ends.
const CHILD =
  "relative flex flex-col items-center px-2 pt-6 " +
  "before:absolute before:right-1/2 before:top-0 before:h-6 before:w-1/2 before:border-t before:border-muted-foreground/40 " +
  "after:absolute after:left-1/2 after:top-0 after:h-6 after:w-1/2 after:border-l after:border-t after:border-muted-foreground/40 " +
  "first:before:border-t-0 last:after:border-t-0 only:before:hidden";
// Vertical stem from a parent card down to its children's rail.
const LEVEL =
  "animate-fade-in relative flex justify-center pt-6 " +
  "before:absolute before:left-1/2 before:top-0 before:h-6 before:border-l before:border-muted-foreground/40";

/** Top-down decision-tree style diagram of the same lazy, RLS-scoped branches. */
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
      <div className="overflow-x-auto pb-4">
        <TreeView label={props.group === "area" ? "Leads by area" : "Leads by service"}>
          <div className="mx-auto flex w-max min-w-full justify-center">
            <div
              role="treeitem"
              aria-level={1}
              aria-expanded
              aria-selected={rootSelected}
              aria-label={`All qualified leads, ${props.total ?? "loading"} leads`}
              tabIndex={-1}
              className="flex flex-col items-center rounded-lg outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <NodeCard
                label="All qualified leads"
                total={props.total}
                newCount={0}
                depth={0}
                selected={rootSelected}
                ratio={1}
                onSelect={() => props.select([])}
              />
              <div role="group" className={LEVEL}>
                <DiagramLevel {...props} parent={[]} />
              </div>
            </div>
          </div>
        </TreeView>
      </div>
    </section>
  );
}

function NodeCard({
  label,
  total,
  newCount,
  depth,
  selected,
  ratio,
  onSelect,
  expandable,
  expanded,
  onToggle,
}: {
  label: string;
  total: number | undefined;
  newCount: number;
  depth: number;
  selected: boolean;
  ratio: number;
  onSelect: () => void;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={cn(
        "relative w-44 rounded-xl border border-t-4 border-border bg-card shadow-sm transition-colors motion-reduce:transition-none hover:bg-accent/40",
        DEPTH_ACCENT[Math.min(depth, DEPTH_ACCENT.length - 1)],
        selected && "bg-primary/10 ring-2 ring-primary/40",
        expandable && "mb-3",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        data-tree-select
        onClick={onSelect}
        className="flex min-h-[4.25rem] w-full flex-col items-center justify-center gap-1.5 rounded-xl px-2 pb-3 pt-2 text-center"
      >
        <span className="line-clamp-2 break-words text-sm font-medium leading-tight" title={label}>
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="crm-pill-text rounded-full bg-muted px-2 py-0.5 tabular-nums text-muted-foreground">
            {total === undefined ? "—" : total.toLocaleString()}
          </span>
          {newCount > 0 && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
              {newCount} new
            </span>
          )}
        </span>
      </button>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-2 bottom-1 h-0.5 overflow-hidden rounded bg-muted"
      >
        <span
          className="block h-full rounded bg-primary/50 transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${Math.max(3, ratio * 100)}%` }}
        />
      </span>
      {expandable && (
        <button
          type="button"
          tabIndex={-1}
          data-tree-toggle
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={onToggle}
          className="absolute -bottom-3 left-1/2 z-10 grid h-6 w-6 -translate-x-1/2 place-items-center rounded-full border border-border bg-card shadow-sm hover:bg-accent"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
        </button>
      )}
    </div>
  );
}

function DiagramLevel(props: Props & { parent: string[] }) {
  const [showAll, setShowAll] = useState(false);
  const query = useExplorerQuery("nodes", props.group, props.parent, props.filters);
  if (query.isPending)
    return (
      <>
        {[0, 1, 2].map((key) => (
          <div key={key} className={CHILD}>
            <Skeleton role="status" aria-label="Loading branches" className="h-[4.25rem] w-44" />
          </div>
        ))}
      </>
    );
  if (query.isError)
    return (
      <div role="alert" className={cn(CHILD, "w-52 text-center text-xs text-muted-foreground")}>
        <p>{friendlyError(query.error)}</p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry branches
        </Button>
      </div>
    );
  const nodes = query.data?.action === "nodes" ? query.data.value : [];
  if (!nodes.length)
    return (
      <div className={cn(CHILD, "text-xs text-muted-foreground")}>
        <span>No branches</span>
      </div>
    );
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
            className={cn(CHILD, "outline-offset-2")}
          >
            <NodeCard
              label={label}
              total={node.total}
              newCount={node.new_count}
              depth={depth + 1}
              selected={selected}
              ratio={node.total / largest}
              onSelect={() => props.select(path)}
              expandable={expandable}
              expanded={expanded}
              onToggle={() => props.toggle(path)}
            />
            {expandable && expanded && (
              <div role="group" className={LEVEL}>
                <DiagramLevel {...props} parent={path} />
              </div>
            )}
          </div>
        );
      })}
      {nodes.length > VISIBLE_CHILDREN && (
        <div className={CHILD}>
          <Button
            size="sm"
            variant="outline"
            className="h-[4.25rem] w-32 whitespace-normal"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${nodes.length.toLocaleString()}`}
          </Button>
        </div>
      )}
    </>
  );
}
