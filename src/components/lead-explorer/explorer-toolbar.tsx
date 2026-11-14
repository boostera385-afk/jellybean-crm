import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STATUS_LABEL } from "@/lib/lead-statuses";
import type { ExplorerSearch } from "@/lib/lead-explorer";

export function ExplorerToolbar({
  state,
  query,
  search,
  update,
  clear,
  mobile,
}: {
  state: ExplorerSearch;
  query: string;
  search: (value: string) => void;
  update: (patch: Partial<ExplorerSearch>) => void;
  clear: () => void;
  mobile: boolean;
}) {
  const selectClass = "h-10 min-w-0 rounded-lg border border-input px-3 text-sm";
  return (
    <section className="crm-section-panel space-y-4" aria-label="Explorer filters">
      <div className="flex flex-col gap-3 xl:flex-row">
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs font-semibold text-muted-foreground">Group by</span>
          <div
            className="flex rounded-xl border border-border bg-muted p-1"
            role="group"
            aria-label="Group leads by"
          >
            {(["area", "service"] as const).map((group) => (
              <Button
                key={group}
                size="sm"
                variant={state.group === group ? "default" : "ghost"}
                aria-pressed={state.group === group}
                onClick={() => update({ group, path: [] })}
              >
                {group === "area" ? "Area" : "Service"}
              </Button>
            ))}
          </div>
        </div>
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search all permitted qualified leads</span>
          <Search
            className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            maxLength={160}
            value={query}
            onChange={(event) => search(event.target.value)}
            placeholder="Search name, phone, service or area…"
            className="h-11 pl-9"
          />
        </label>
        <Button variant="outline" onClick={clear}>
          <X className="mr-2 h-4 w-4" />
          Clear filters
        </Button>
      </div>
      <details open={!mobile} className="group">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-semibold text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          Dates and filters
          {(state.from ||
            state.to ||
            state.status ||
            state.owner !== "all" ||
            state.important ||
            state.due) && (
            <span className="crm-pill-text rounded-full bg-primary/10 px-2 py-0.5 text-primary">
              Active
            </span>
          )}
          <ChevronDown
            className="ml-auto h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="min-w-0 space-y-1">
            <span className="crm-lead-label">Created from · PKT</span>
            <Input
              aria-label="Created from date in PKT"
              type="date"
              value={state.from ?? ""}
              max={state.to}
              onChange={(event) => update({ from: event.target.value || undefined })}
            />
          </label>
          <label className="min-w-0 space-y-1">
            <span className="crm-lead-label">Created through · PKT</span>
            <Input
              aria-label="Created through date in PKT"
              type="date"
              value={state.to ?? ""}
              min={state.from}
              onChange={(event) => update({ to: event.target.value || undefined })}
            />
          </label>
          <label className="min-w-0 space-y-1">
            <span className="crm-lead-label">Status</span>
            <select
              className={`${selectClass} w-full`}
              value={state.status ?? ""}
              onChange={(event) =>
                update({ status: (event.target.value || undefined) as ExplorerSearch["status"] })
              }
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 space-y-1">
            <span className="crm-lead-label">Assigned owner</span>
            <select
              className={`${selectClass} w-full`}
              value={state.owner}
              onChange={(event) => update({ owner: event.target.value as ExplorerSearch["owner"] })}
            >
              <option value="all">All permitted owners</option>
              <option value="mine">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.important}
              onChange={(event) => update({ important: event.target.checked })}
            />
            Important only
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.due}
              onChange={(event) => update({ due: event.target.checked })}
            />
            Follow-up due
          </label>
        </div>
      </details>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Search covers all permitted qualified leads. A branch narrows results. Search text is not
        saved in links.
      </p>
    </section>
  );
}
