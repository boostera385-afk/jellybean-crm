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
      <div
        className="grid grid-cols-3 gap-2 sm:gap-3"
        aria-label="Selected branch summary"
        aria-live="polite"
      >
        {[
          ["Matching leads", counts?.total],
          ["New to contact", counts?.new_count],
          ["Follow-up due", counts?.followup_due],
        ].map(([label, value]) => (
          <div
            key={label}
            className="crm-surface-card flex min-w-0 flex-col items-start justify-between gap-2 border border-border px-3 py-3 sm:flex-row sm:items-center sm:px-4"
          >
            <span className="crm-card-label">{label}</span>
            <span className="text-xl font-bold tabular-nums">
              {typeof value === "number" ? value.toLocaleString() : "—"}
            </span>
          </div>
        ))}
      </div>
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
      <div className="grid min-w-0 items-start gap-4 md:grid-cols-[minmax(240px,30%)_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
        {mobile ? (
          <ExplorerDrilldown
            group={state.group}
            path={state.path}
            filters={filters}
            select={select}
          />
        ) : (
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
