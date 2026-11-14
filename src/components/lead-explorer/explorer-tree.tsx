import { ChevronRight, FolderTree, RotateCcw } from "lucide-react";
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
};

export function ExplorerTree(props: Props & { collapse: () => void }) {
  return (
    <section
      className="crm-section-panel min-w-0 md:sticky md:top-4"
      aria-label="Browse lead hierarchy"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="crm-section-title !text-sm">
          <FolderTree className="h-4 w-4" /> Browse hierarchy
        </h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={props.collapse}
          aria-label="Collapse all branches"
          title="Collapse all"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
      <Button
        variant="ghost"
        className="mb-3 w-full justify-start"
        onClick={() => props.select([])}
      >
        All qualified leads
      </Button>
      <div className="max-h-[65vh] overflow-auto p-1">
        <TreeView label={props.group === "area" ? "Leads by area" : "Leads by service"}>
          <TreeLevel {...props} parent={[]} />
        </TreeView>
      </div>
    </section>
  );
}

function TreeLevel(props: Props & { parent: string[] }) {
  const query = useExplorerQuery("nodes", props.group, props.parent, props.filters);
  if (query.isPending) return <TreeLoading />;
  if (query.isError) return <TreeError error={query.error} retry={() => void query.refetch()} />;
  const nodes = query.data?.action === "nodes" ? query.data.value : [];
  return nodes.map((node) => {
    const path = [...props.parent, node.key];
    const expandable = path.length < (props.group === "area" ? 3 : 2);
    const expanded = props.expanded.has(branchId(props.group, path));
    const selected = branchId(props.group, path) === branchId(props.group, props.path);
    const label = branchLabel(props.group, props.parent.length, node.key);
    return (
      <div
        key={node.key}
        role="treeitem"
        aria-label={`${label}, ${node.total} leads`}
        aria-level={path.length}
        aria-expanded={expandable ? expanded : undefined}
        aria-selected={selected}
        tabIndex={-1}
        className="rounded-lg outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <div
          className={cn(
            "flex min-h-10 items-center gap-1 rounded-lg px-1 text-sm transition-colors motion-reduce:transition-none hover:bg-accent/50",
            selected && "bg-primary/10 text-primary ring-1 ring-inset ring-primary/25",
          )}
        >
          {expandable ? (
            <button
              type="button"
              tabIndex={-1}
              data-tree-toggle
              aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
              className="grid h-9 w-7 shrink-0 place-items-center rounded hover:bg-accent"
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
            <span className="w-7 shrink-0" />
          )}
          <button
            type="button"
            tabIndex={-1}
            data-tree-select
            onClick={() => props.select(path)}
            className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
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
        </div>
        {expandable && expanded && (
          <div role="group" className="ml-3 border-l border-border pl-2">
            <TreeLevel {...props} parent={path} />
          </div>
        )}
      </div>
    );
  });
}

export function ExplorerDrilldown({
  group,
  path,
  filters,
  select,
}: Pick<Props, "group" | "path" | "filters" | "select">) {
  const canDescend = path.length < (group === "area" ? 3 : 2);
  const query = useExplorerQuery("nodes", group, path, filters, canDescend);
  if (!canDescend) return null;
  return (
    <section className="crm-section-panel space-y-2" aria-label="Browse next hierarchy level">
      <h2 className="crm-section-title !text-sm">
        Browse{" "}
        {group === "area"
          ? ["states", "main areas", "sub-areas"][path.length]
          : path.length
            ? "services"
            : "categories"}
      </h2>
      {query.isPending ? (
        <TreeLoading />
      ) : query.isError ? (
        <TreeError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="max-h-64 overflow-auto">
          {(query.data?.action === "nodes" ? query.data.value : []).map((node) => (
            <button
              key={node.key}
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-accent"
              onClick={() => select([...path, node.key])}
            >
              <span className="min-w-0 flex-1 break-words">
                {branchLabel(group, path.length, node.key)}
              </span>
              <span className="crm-pill-text tabular-nums text-muted-foreground">
                {node.total.toLocaleString()}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function TreeLoading() {
  return (
    <div role="status" aria-label="Loading branches" className="space-y-2 p-2">
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-9 w-full" />
      ))}
    </div>
  );
}
function TreeError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="p-2 text-xs text-muted-foreground">
      <p>{friendlyError(error)}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Retry branches
      </Button>
    </div>
  );
}
