import { useEffect, useRef } from "react";
import { ArrowUpRight, BellRing, MapPin, SearchX } from "lucide-react";
import { useExplorerResults } from "@/hooks/use-lead-explorer";
import { locationPath, type ExplorerFilters, type ExplorerGroup } from "@/lib/lead-explorer";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/lead-statuses";
import { formatPhone } from "@/lib/crm-lite";
import { friendlyError } from "@/lib/error-messages";
import { formatPKT } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function ExplorerResults({
  group,
  path,
  filters,
  total,
  open,
}: {
  group: ExplorerGroup;
  path: string[];
  filters: ExplorerFilters;
  total: number | undefined;
  open: (id: string) => void;
}) {
  const query = useExplorerResults(group, path, filters);
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  // Concurrent inserts can shift pages during refetch; never show a lead twice.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  // Load the next 50 rows as the list end approaches; the button remains as a fallback.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const unique = rows.filter(
    (row, index) => rows.findIndex((other) => other.id === row.id) === index,
  );
  return (
    <section
      className="crm-section-panel min-w-0"
      aria-label="Lead results"
      aria-busy={query.isFetching}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="crm-section-title">Lead results</h2>
        <span role="status" className="text-xs tabular-nums text-muted-foreground">
          {unique.length.toLocaleString()} shown
          {total !== undefined ? ` of ${total.toLocaleString()}` : ""} · Newest first
        </span>
      </div>
      {query.isPending && (
        <div role="status" aria-label="Loading leads" className="space-y-3">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-28 w-full" />
          ))}
        </div>
      )}
      {query.isError && (
        <div role="alert" className="mb-4 space-y-2 text-sm">
          <p>{friendlyError(query.error)}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry results
          </Button>
        </div>
      )}
      {!query.isPending && !query.isError && unique.length === 0 && (
        <div className="grid place-items-center gap-3 py-16 text-center">
          <SearchX className="h-8 w-8 text-muted-foreground" />
          <h3 className="!text-base">No matching leads</h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            This branch has no leads matching your current filters. Try another branch or clear the
            filters.
          </p>
        </div>
      )}
      <div className="space-y-2">
        {unique.map((lead) => (
          <button
            type="button"
            key={lead.id}
            onClick={() => open(lead.id)}
            className="crm-lead-card animate-fade-in block w-full min-w-0 text-left transition-transform focus-visible:outline-2 focus-visible:outline-ring motion-safe:hover:-translate-y-px"
            aria-label={`View ${lead.customer_name || "Unnamed customer"}`}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="crm-lead-title min-w-0 break-words">
                    {lead.customer_name || "Unnamed customer"}
                  </h3>
                  <span
                    className={cn(
                      "crm-pill-text rounded-full border px-2 py-0.5",
                      STATUS_TONE[lead.cs_status],
                    )}
                  >
                    {STATUS_LABEL[lead.cs_status] ?? lead.cs_status}
                  </span>
                  {lead.is_important && <span className="text-xs text-warning">Important</span>}
                  {lead.cs_status === "need_follow_up" &&
                    lead.followup_at &&
                    new Date(lead.followup_at).getTime() <= Date.now() && (
                      <span className="inline-flex items-center gap-1 text-xs text-warning">
                        <BellRing className="h-3 w-3" aria-hidden="true" /> Follow-up due
                      </span>
                    )}
                </div>
                <p className="mt-1 break-words text-sm">{lead.service || "Unspecified service"}</p>
                <p className="crm-lead-meta mt-1">
                  {lead.customer_number ? formatPhone(lead.customer_number) : "No phone number"}
                </p>
                <p className="crm-lead-meta mt-2 flex items-start gap-1">
                  <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-words">{locationPath(lead)}</span>
                </p>
                <p className="crm-lead-meta mt-1">Created {formatPKT(lead.created_at)} PKT</p>
              </div>
              <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </button>
        ))}
      </div>
      {query.hasNextPage && (
        <div ref={sentinel} className="mt-4 flex justify-center">
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </section>
  );
}
