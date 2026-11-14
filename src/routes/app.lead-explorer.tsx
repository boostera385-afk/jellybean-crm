import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ListTree, RefreshCw } from "lucide-react";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { RouteSkeleton } from "@/components/route-skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { useExplorerQuery } from "@/hooks/use-lead-explorer";
import {
  branchId,
  branchLabel,
  canExplore,
  EXPLORER_ROLES,
  explorerSearchSchema,
  type ExplorerFilters,
  type ExplorerSearch,
} from "@/lib/lead-explorer";
import { friendlyError } from "@/lib/error-messages";
import { ExplorerToolbar } from "@/components/lead-explorer/explorer-toolbar";
import { ExplorerTree, ExplorerDrilldown } from "@/components/lead-explorer/explorer-tree";
import { ExplorerDiagram } from "@/components/lead-explorer/explorer-diagram";
import { ExplorerResults } from "@/components/lead-explorer/results-list";
import { LeadDrawer } from "@/components/lead-explorer/lead-drawer";

export const Route = createFileRoute("/app/lead-explorer")({
  head: () => ({
    meta: [
      { title: "Lead Explorer · JellyBean" },
      { name: "description", content: "Explore qualified leads by area and service." },
    ],
  }),
  validateSearch: (search) => explorerSearchSchema.parse(search),
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
  component: LeadExplorerPage,
});

function LeadExplorerPage() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Lead Explorer"
        description="Explore qualified leads by location and service without losing the bigger picture."
      />
      <PageBody className="!pt-5">
        <RoleGate allow={EXPLORER_ROLES} current={auth.primaryRole}>
          {canExplore(auth.primaryRole) && <ExplorerWorkspace />}
        </RoleGate>
      </PageBody>
    </div>
  );
}

function ExplorerWorkspace() {
  const state = Route.useSearch();
  const navigate = Route.useNavigate();
  const mobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const filters = useMemo<ExplorerFilters>(
    () => ({
      query: debounced,
      from: state.from,
      to: state.to,
      status: state.status,
      owner: state.owner,
      important: state.important,
      due: state.due,
    }),
    [debounced, state.from, state.to, state.status, state.owner, state.important, state.due],
  );
  const summary = useExplorerQuery("summary", state.group, state.path, filters);
  const counts = summary.data?.action === "summary" ? summary.data.value : undefined;
  // The diagram root always shows the whole filtered population, not the selected branch.
  const rootSummary = useExplorerQuery(
    "summary",
    state.group,
    [],
    filters,
    !mobile && state.view === "diagram",
  );
  function update(patch: Partial<ExplorerSearch>, replace = false) {
    void navigate({
      search: (previous) => ({ ...previous, ...patch }),
      replace,
      resetScroll: false,
    });
  }
  function select(path: string[]) {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (let depth = 1; depth < path.length; depth++)
        next.add(branchId(state.group, path.slice(0, depth)));
      // Selecting a branch also reveals its children.
      if (path.length && path.length < (state.group === "area" ? 3 : 2))
        next.add(branchId(state.group, path));
      return next;
    });
    update({ path });
  }
  // A directly opened URL expands its ancestors without resetting expansion on refetch.
  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (let depth = 1; depth < state.path.length; depth++)
        next.add(branchId(state.group, state.path.slice(0, depth)));
      return next.size === previous.size ? previous : next;
    });
  }, [state.group, state.path]);
  function toggle(path: string[]) {
    const id = branchId(state.group, path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <div className="min-w-0 space-y-4">
      <ExplorerToolbar
        mobile={mobile}
        state={state}
        query={query}
        search={(value) => {
          setQuery(value);
          if (state.path.length) update({ path: [] }, true);
        }}
        update={update}
        clear={() => {
          setQuery("");
          setDebounced("");
          update({
            path: [],
            from: undefined,
            to: undefined,
            status: undefined,
            owner: "all",
            important: false,
            due: false,
          });
        }}
      />
      {summary.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          <p>{friendlyError(summary.error)}</p>
          <Button size="sm" variant="outline" onClick={() => void summary.refetch()}>
            <RefreshCw className="mr-2 h-3 w-3" />
            Retry summary
          </Button>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <nav
          aria-label="Selected lead branch"
          className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
        >
          <ListTree className="mr-1 h-4 w-4 text-primary" />
          <button
            type="button"
            className="rounded px-1 py-2 text-muted-foreground hover:text-primary"
            onClick={() => select([])}
          >
            All leads
          </button>
          {state.path.map((key, index) => (
            <span key={`${index}-${key}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              <button
                type="button"
                aria-current={index === state.path.length - 1 ? "location" : undefined}
                className="min-w-0 break-words rounded px-1 py-2 text-left hover:text-primary"
                onClick={() => select(state.path.slice(0, index + 1))}
              >
                {branchLabel(state.group, index, key)}
              </button>
            </span>
          ))}
        </nav>
        <div
          className="flex flex-wrap items-center gap-2 text-xs"
          aria-label="Selected branch summary"
          aria-live="polite"
        >
          {[
            ["Matching", counts?.total, "bg-primary/10 text-primary"],
            ["New", counts?.new_count, "bg-warning/10 text-warning"],
            ["Follow-up due", counts?.followup_due, "bg-muted text-muted-foreground"],
          ].map(([label, value, tone]) => (
            <span key={label as string} className={`rounded-full px-2.5 py-1 font-medium ${tone}`}>
              {label}{" "}
              <b className="tabular-nums">
                {typeof value === "number" ? value.toLocaleString() : "—"}
              </b>
            </span>
          ))}
        </div>
      </div>
      {!mobile && (
        <div
          className="flex w-fit rounded-xl border border-border bg-muted p-1"
          role="group"
          aria-label="Hierarchy view"
        >
          {(["list", "diagram"] as const).map((view) => (
            <Button
              key={view}
              size="sm"
              variant={state.view === view ? "default" : "ghost"}
              aria-pressed={state.view === view}
              onClick={() => update({ view })}
            >
              {view === "list" ? "List" : "Diagram"}
            </Button>
          ))}
        </div>
      )}
      {!mobile && state.view === "diagram" && (
        <ExplorerDiagram
          group={state.group}
          path={state.path}
          filters={filters}
          expanded={expanded}
          toggle={toggle}
          select={select}
          total={rootSummary.data?.action === "summary" ? rootSummary.data.value.total : undefined}
          collapse={() => setExpanded(new Set())}
        />
      )}
      <div
        className={
          !mobile && state.view === "diagram"
            ? "min-w-0"
            : "grid min-w-0 items-start gap-4 md:grid-cols-[minmax(240px,30%)_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]"
        }
      >
        {mobile ? (
          <ExplorerDrilldown
            group={state.group}
            path={state.path}
            filters={filters}
            select={select}
          />
        ) : state.view === "diagram" ? null : (
          <ExplorerTree
            group={state.group}
            path={state.path}
            filters={filters}
            expanded={expanded}
            toggle={toggle}
            select={select}
            collapse={() => setExpanded(new Set())}
          />
        )}
        <ExplorerResults
          group={state.group}
          path={state.path}
          filters={filters}
          total={counts?.total}
          open={(leadId) => update({ leadId })}
        />
      </div>
      <LeadDrawer
        leadId={state.leadId}
        group={state.group}
        filters={filters}
        close={() => update({ leadId: undefined })}
      />
    </div>
  );
}
