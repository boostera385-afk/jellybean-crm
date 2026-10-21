import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow, startOfDay, endOfDay } from "date-fns";
import {
  Download,
  Loader2,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { downloadCsv } from "@/lib/crm-lite";

export const Route = createFileRoute("/app/logs")({
  head: () => ({
    meta: [
      { title: "Activity Logs \u00b7 JellyBean" },
      { name: "description", content: "Review the JellyBean operations audit trail." },
      { property: "og:title", content: "Activity Logs \u00b7 JellyBean" },
      { property: "og:description", content: "Review the JellyBean operations audit trail." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader title="Activity Logs" description="Audit trail of operations across the CRM." />
      <PageBody>
        <RoleGate allow={["admin"]} current={auth.primaryRole}>
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 500;

  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const dbSearch = useMemo(() => {
    return debouncedQuery.replace(/[,"'%\\]/g, ""); // Strip characters that break postgrest .or()
  }, [debouncedQuery]);

  const dbDateFrom = useMemo(() => {
    return dateFrom ? startOfDay(new Date(dateFrom)).toISOString() : null;
  }, [dateFrom]);

  const dbDateTo = useMemo(() => {
    return dateTo ? endOfDay(new Date(dateTo)).toISOString() : null;
  }, [dateTo]);

  useEffect(() => {
    setPage(1);
  }, [dbDateFrom, dbDateTo, dbSearch]);

  const logs = useQuery({
    queryKey: ["activity_logs", { page, dbDateFrom, dbDateTo, dbSearch }],
    queryFn: async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let request = supabase
        .from("activity_logs")
        .select("id, created_at, actor_name, actor_role, action, entity_type, metadata")
        .order("created_at", { ascending: false })
        .range(from, to);

      if (dbDateFrom) request = request.gte("created_at", dbDateFrom);
      if (dbDateTo) request = request.lte("created_at", dbDateTo);

      if (dbSearch) {
        const s = `%${dbSearch}%`;
        request = request.or(
          `actor_name.ilike.${s},actor_role.ilike.${s},action.ilike.${s},entity_type.ilike.${s}`,
        );
      }

      const { data, error } = await request;
      if (error) throw error;
      return data ?? [];
    },
    placeholderData: keepPreviousData,
  });

  const totalCount = useQuery({
    queryKey: ["activity_logs_count", { dbDateFrom, dbDateTo, dbSearch }],
    queryFn: async () => {
      let request = supabase.from("activity_logs").select("id", { count: "exact", head: true });

      if (dbDateFrom) request = request.gte("created_at", dbDateFrom);
      if (dbDateTo) request = request.lte("created_at", dbDateTo);

      if (dbSearch) {
        const s = `%${dbSearch}%`;
        request = request.or(
          `actor_name.ilike.${s},actor_role.ilike.${s},action.ilike.${s},entity_type.ilike.${s}`,
        );
      }

      const { count, error } = await request;
      if (error) throw error;
      return count ?? 0;
    },
    placeholderData: keepPreviousData,
  });

  const totalPages = Math.max(1, Math.ceil((totalCount.data ?? 0) / PAGE_SIZE));

  const visible = useMemo(() => {
    return logs.data ?? [];
  }, [logs.data]);

  function exportLogs() {
    downloadCsv(
      "activity-logs.csv",
      ["Created", "Actor", "Role", "Action", "Entity", "Details"],
      visible.map((log) => [
        log.created_at,
        log.actor_name ?? "",
        log.actor_role ?? "",
        log.action,
        log.entity_type ?? "",
        log.metadata ? JSON.stringify(log.metadata) : "",
      ]),
    );
  }

  return (
    <div className="space-y-4">
      <div className="crm-toolbar-panel">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search actor, action, entity..."
              className="h-9 pl-9"
            />
          </div>
          <Input
            type="date"
            aria-label="Activity log start date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            className="h-9 w-[150px]"
          />
          <Input
            type="date"
            aria-label="Activity log end date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
            className="h-9 w-[150px]"
          />
          <Button size="sm" variant="outline" className="h-9" onClick={exportLogs}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export
          </Button>
        </div>
      </div>

      {logs.error && (
        <div className="text-[12.5px] text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {(logs.error as Error).message}
        </div>
      )}

      <div className="crm-section-panel">
        <div className="crm-surface-card overflow-x-auto">
          <table className="crm-table min-w-[900px]">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Role</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.isLoading && !logs.data && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                    Loading...
                  </td>
                </tr>
              )}
              {!logs.isLoading && visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    <Search className="h-5 w-5 mx-auto mb-2 opacity-50" />
                    No activity logs found for the selected date range.
                  </td>
                </tr>
              )}
              {visible.map((log) => (
                <tr key={log.id}>
                  <td
                    className="text-xs text-muted-foreground whitespace-nowrap"
                    title={new Date(log.created_at).toLocaleString()}
                  >
                    {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                  </td>
                  <td className="font-medium">{log.actor_name ?? "-"}</td>
                  <td className="capitalize text-sm">{log.actor_role ?? "-"}</td>
                  <td className="font-mono text-xs">{log.action}</td>
                  <td className="font-mono text-xs">{log.entity_type ?? "-"}</td>
                  <td className="font-mono text-xs text-muted-foreground max-w-xs">
                    <div className="truncate">
                      {log.metadata ? JSON.stringify(log.metadata) : "-"}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-4">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={() => setPage(1)}
            disabled={page <= 1 || logs.isFetching}
            title="First Page"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-[12px]"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || logs.isFetching}
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" />
            Previous
          </Button>
          <span className="text-[12px] text-muted-foreground tabular-nums px-2">
            Page {page} of {totalPages}
            {totalCount.data != null && (
              <span className="ml-1 text-[11px]">({totalCount.data} total)</span>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-[12px]"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || logs.isFetching}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages || logs.isFetching}
            title="Last Page"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
