import { createFileRoute, Link } from "@tanstack/react-router";
import { RouteSkeleton } from "@/components/route-skeleton";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  User,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { downloadCsv } from "@/lib/crm-lite";
import { isCsUser } from "@/lib/cs-filter";
import { friendlyError } from "@/lib/error-messages";
import { cn } from "@/lib/utils";
import { parseAiStatusReport } from "@/lib/ai-status-report";
import { toast } from "sonner";
import { STATUS_LABEL } from "@/lib/lead-statuses";

type DatePreset = "all" | "today" | "yesterday" | "7d" | "30d" | "custom";

function toIsoDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
}
function computeRange(preset: DatePreset, from: string, to: string) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  switch (preset) {
    case "today":
      return { from: startOfToday.toISOString(), to: startOfTomorrow.toISOString() };
    case "yesterday": {
      const y = new Date(startOfToday);
      y.setDate(y.getDate() - 1);
      return { from: y.toISOString(), to: startOfToday.toISOString() };
    }
    case "7d": {
      const s = new Date(startOfToday);
      s.setDate(s.getDate() - 6);
      return { from: s.toISOString(), to: startOfTomorrow.toISOString() };
    }
    case "30d": {
      const s = new Date(startOfToday);
      s.setDate(s.getDate() - 29);
      return { from: s.toISOString(), to: startOfTomorrow.toISOString() };
    }
    case "custom": {
      const f = from ? new Date(from + "T00:00:00").toISOString() : null;
      const t = to
        ? (() => {
            const d = new Date(to + "T00:00:00");
            d.setDate(d.getDate() + 1);
            return d.toISOString();
          })()
        : null;
      return { from: f, to: t };
    }
    default:
      return { from: null, to: null };
  }
}

export const Route = createFileRoute("/app/reports")({
  head: () => ({
    meta: [
      { title: "Reports \u00b7 JellyBean" },
      { name: "description", content: "Review lead delivery outcomes and team reports." },
      { property: "og:title", content: "Reports \u00b7 JellyBean" },
      { property: "og:description", content: "Review lead delivery outcomes and team reports." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
});

const RAW_STATUSES = ["new", "forwarded", "not_found", "wrong", "duplicate"] as const;
export const CS_STATUSES = [
  "new",
  "undeliver",
  "wrong_number",
  "wrong_lead",
  "already_got_someone",
  "already_received_before",
  "service_provider_himself",
  "converted",
  "cx_interested",
  "cx_not_interested",
  "cx_didnt_replied",
  "need_follow_up",
  "out_of_base",
] as const;

export type CsStatus = (typeof CS_STATUSES)[number];

const RAW_LABELS: Record<string, string> = {
  new: "New",
  forwarded: "Forwarded to CS",
  not_found: "Number not found",
  wrong: "Wrong posts",
  duplicate: "Duplicate",
};

const CS_LABELS: Record<string, string> = {
  new: "New to contact",
  undeliver: "Undeliver",
  wrong_number: "Wrong Number",
  wrong_lead: "Wrong Lead",
  already_got_someone: "Already Got Someone",
  already_received_before: "Already received before",
  service_provider_himself: "Service Provider Himself",
  converted: "Delivered",
  cx_interested: "CX interested",
  cx_not_interested: "CX not interested",
  cx_didnt_replied: "CX didn't replied",
  need_follow_up: "Need Follow Up",
  out_of_base: "Out of Base",
};

const RAW_COLORS: Record<string, string> = {
  new: "var(--color-chart-1, #3b82f6)",
  forwarded: "var(--color-success, #10b981)",
  not_found: "var(--color-warning, #f59e0b)",
  wrong: "var(--color-destructive, #ef4444)",
  duplicate: "#a855f7",
};

const CS_STATUS_COLORS: Record<string, string> = {
  cx_interested: "var(--success)",
  cx_not_interested: "var(--destructive)",
  cx_didnt_replied: "var(--warning)",
  new: "#38bdf8",
  converted: "#4ade80",
  need_follow_up: "#60a5fa",
  out_of_base: "#fb923c",
  undeliver: "#f87171",
  wrong_number: "#ef4444",
  wrong_lead: "#f43f5e",
  already_got_someone: "#94a3b8",
  already_received_before: "#cbd5e1",
  service_provider_himself: "#a8a29e",
};

function statusDotTone(status: string) {
  if (status === "cx_interested") return "bg-success";
  if (status === "cx_not_interested") return "bg-destructive";
  if (status === "cx_didnt_replied") return "bg-warning";
  if (status === "converted" || status === "closed_won") return "bg-emerald-500";
  if (
    status === "need_follow_up" ||
    status === "follow_up" ||
    status === "called" ||
    status === "messaged"
  ) {
    return "bg-sky-500";
  }
  if (
    status === "undeliver" ||
    status === "wrong_number" ||
    status === "wrong_lead" ||
    status === "wrong_service" ||
    status === "wrong_person" ||
    status === "not_interested" ||
    status === "already_done" ||
    status === "closed_lost"
  ) {
    return "bg-rose-500";
  }
  if (
    status === "already_got_someone" ||
    status === "already_received_before" ||
    status === "service_provider_himself" ||
    status === "small_service"
  ) {
    return "bg-slate-400";
  }
  return "bg-sky-400";
}

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader title="Reports" description="Operational counts across the pipeline." />
      <PageBody>
        <RoleGate
          allow={["admin", "sub_admin"]}
          current={auth.primaryRole}
          allowOverride={auth.features.includes("reports")}
        >
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.primaryRole === "admin";
  // The AI/Quo beta comparison is backed by Quo-integration endpoints that
  // only admin, sub-admin and CS admin may call. Users granted Reports via
  // Feature Access see the manual report sections without this admin-only block.
  const canSeeAiReporting =
    auth.primaryRole === "admin" ||
    auth.primaryRole === "sub_admin" ||
    auth.primaryRole === "cs_admin";
  // Per-user forwarding breakdown is restricted to admin / sub-admin server-side.
  const canSeeForwardedByUser = auth.primaryRole === "admin" || auth.primaryRole === "sub_admin";
  const today = toIsoDay(new Date());
  const [preset, setPreset] = useState<DatePreset>("all");
  const [fromDate, setFromDate] = useState<string>(today);
  const [toDate, setToDate] = useState<string>(today);
  const range = useMemo(() => computeRange(preset, fromDate, toDate), [preset, fromDate, toDate]);

  const ai = useQuery({
    queryKey: ["report-ai-status", range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_lead_ai_status", {
        p_from: range.from ?? undefined,
        p_to: range.to ?? undefined,
      });
      if (error) throw error;
      return parseAiStatusReport(data);
    },
    enabled: canSeeAiReporting,
    staleTime: 30_000,
    retry: false,
  });
  const aiConfiguration = useQuery({
    queryKey: ["ai-status-configuration"],
    enabled: canSeeAiReporting,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("quo-ai-status", {
        body: { action: "configuration" },
      });
      if (error) throw error;
      return data as {
        configured: boolean;
        message?: string;
        phoneNumberCount?: number;
        phoneNumberSource?: string;
      };
    },
    staleTime: 60_000,
    retry: false,
  });
  const refreshAi = useMutation({
    mutationFn: async (scope: { from: string | null; to: string | null }) => {
      const { data, error } = await supabase.functions.invoke("quo-ai-status", {
        body: { action: "refresh", ...scope },
      });
      if (error || data?.error)
        throw new Error("AI refresh failed. Check Quo configuration and try again.");
      return data as { processed: number; message: string; results: Array<{ state: string }> };
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["report-ai-status"] });
      void queryClient.invalidateQueries({ queryKey: ["quo-ai-progress"] });
      const classified = data.results.filter((r) => r.state === "classified").length;
      toast.success(
        data.processed
          ? `${classified} classified / ${data.processed} checked. Manual statuses unchanged.`
          : data.message,
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const progress = useQuery({
    queryKey: ["quo-ai-progress", range.from, range.to],
    enabled: Boolean(aiConfiguration.data?.configured),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_quo_ai_progress", {
        p_from: range.from ?? undefined,
        p_to: range.to ?? undefined,
      });
      if (error) throw error;
      return data as { pending: number; workDone: number; workTotal: number };
    },
    refetchInterval: 5_000,
    retry: false,
  });
  useEffect(() => {
    if (!aiConfiguration.data?.configured || !progress.data?.pending) return;
    let inFlight = false;
    let stopped = false;
    const tick = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const { data, error } = await supabase.functions.invoke("quo-ai-status", {
          body: { action: "work" },
        });
        if (!stopped && !error) {
          if (data?.processed)
            void queryClient.invalidateQueries({ queryKey: ["report-ai-status"] });
          void queryClient.invalidateQueries({ queryKey: ["quo-ai-progress"] });
        }
      } catch {
        // Cron resumes persisted work if a browser/network request is interrupted.
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 7_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [aiConfiguration.data?.configured, progress.data?.pending, queryClient]);
  useEffect(() => {
    if (progress.data?.pending === 0)
      void queryClient.invalidateQueries({ queryKey: ["report-ai-status"] });
  }, [progress.data?.pending, queryClient]);

  const raw = useQuery({
    queryKey: ["report-raw", range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "report_raw_status_counts" as never,
        {
          p_from: range.from,
          p_to: range.to,
        } as never,
      );
      if (error) throw error;
      const counts = (data ?? {}) as Record<string, number | string>;
      return Object.fromEntries(
        RAW_STATUSES.map((status) => [status, Number(counts[status] ?? 0)]),
      ) as Record<string, number>;
    },
    staleTime: 60_000,
  });
  const cs = useQuery({
    queryKey: ["report-cs", range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "report_cs_status_counts" as never,
        {
          p_from: range.from,
          p_to: range.to,
        } as never,
      );
      if (error) throw error;
      const counts = (data ?? {}) as Record<string, number | string>;
      return Object.fromEntries(
        CS_STATUSES.filter((status) => Number(counts[status] ?? 0) > 0).map((status) => [
          status,
          Number(counts[status]),
        ]),
      ) as Record<string, number>;
    },
    staleTime: 60_000,
  });
  const notFoundByUser = useQuery({
    queryKey: ["report-not-found-by-user", range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_not_found_by_user", {
        _from: range.from ?? undefined,
        _to: range.to ?? undefined,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        user_id: string | null;
        user_name: string;
        user_email: string | null;
        not_found_count: number;
      }>;
    },
  });

  const [searchNotFound, setSearchNotFound] = useState("");

  const rawTotal = useMemo(
    () => Object.values(raw.data ?? {}).reduce((acc, v) => acc + v, 0),
    [raw.data],
  );

  const csTotal = useMemo(
    () => Object.values(cs.data ?? {}).reduce((acc, v) => acc + v, 0),
    [cs.data],
  );

  const notFoundRows = useMemo(() => {
    const list = notFoundByUser.data ?? [];
    if (!searchNotFound.trim()) return list;
    const q = searchNotFound.toLowerCase();
    return list.filter(
      (r) =>
        r.user_name.toLowerCase().includes(q) ||
        (r.user_email && r.user_email.toLowerCase().includes(q)),
    );
  }, [notFoundByUser.data, searchNotFound]);

  function exportReport() {
    downloadCsv(
      "crm-report.csv",
      ["Section", "Metric", "Value"],
      [
        ...Object.entries(raw.data ?? {}).map(([label, value]) => [
          "Raw leads",
          RAW_LABELS[label] ?? label.replace(/_/g, " "),
          value,
        ]),
        ...Object.entries(cs.data ?? {}).map(([label, value]) => [
          "CS pipeline",
          CS_LABELS[label] ?? label.replace(/_/g, " "),
          value,
        ]),
        ...(ai.data && !ai.isError
          ? Object.entries(ai.data.counts).map(([label, value]) => [
              "AI status (beta)",
              CS_LABELS[label] ?? label,
              value,
            ])
          : []),
      ],
    );
  }

  return (
    <div className="space-y-8">
      {/* ─── Date Range Toolbar ─── */}
      <div className="crm-toolbar-panel">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ["all", "All time"],
                ["today", "Today"],
                ["yesterday", "Yesterday"],
                ["7d", "Weekly"],
                ["30d", "Monthly"],
                ["custom", "Custom"],
              ] as Array<[DatePreset, string]>
            ).map(([key, label]) => (
              <Button
                key={key}
                size="sm"
                variant={preset === key ? "default" : "outline"}
                className={cn(
                  "h-8 px-3 text-xs transition-all",
                  preset === key && "font-semibold shadow-xs",
                )}
                onClick={() => setPreset(key)}
              >
                {label}
              </Button>
            ))}

            {preset === "custom" && (
              <div className="flex items-center gap-1.5 ml-1">
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="h-8 w-[140px] text-xs"
                />
                <span className="text-xs text-muted-foreground">→</span>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="h-8 w-[140px] text-xs"
                />
              </div>
            )}
          </div>

          {isAdmin && (
            <Button size="sm" variant="outline" className="h-8" onClick={exportReport}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export counts
            </Button>
          )}
        </div>
      </div>

      {/* ─── Raw Leads by Status ─── */}
      <Section
        title="Raw leads by status"
        subtitle={`Captured leads pipeline distribution (${rawTotal.toLocaleString()} total)`}
      >
        <Grid>
          {RAW_STATUSES.map((k) => (
            <StatCard
              key={k}
              label={RAW_LABELS[k] ?? k.replace(/_/g, " ")}
              value={raw.data?.[k] ?? 0}
              total={rawTotal}
              color={RAW_COLORS[k]}
            />
          ))}
        </Grid>
      </Section>

      {/* ─── CS Pipeline by Status ─── */}
      <Section
        title="CS pipeline by status"
        subtitle={`Qualified leads across customer service stages (${csTotal.toLocaleString()} total)`}
      >
        {canSeeAiReporting && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
            <div className="min-w-0 text-xs">
              <p className="font-semibold text-sky-700 dark:text-sky-300">
                AI status · Beta · Comparison only
              </p>
              <p className="mt-1 text-muted-foreground">
                Large totals are manual. AI counts use complete Quo SMS history; calls and
                attachment contents are not analyzed.
              </p>
              {ai.data?.scopeStart && (
                <p className="mt-1 text-muted-foreground">
                  Applies to leads created since{" "}
                  {new Date(ai.data.scopeStart).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                  . Leads not contacted yet get no AI status.
                </p>
              )}
              <p className="mt-1 text-muted-foreground" role="status">
                {ai.isError
                  ? "AI reporting is unavailable. Manual totals are unaffected."
                  : ai.isPending
                    ? "Loading AI coverage…"
                    : `${ai.data.classified.toLocaleString()} / ${ai.data.total.toLocaleString()} classified · ${ai.data.disagreements.toLocaleString()} differ from manual · ${ai.data.review.toLocaleString()} need review${ai.data.untouched ? ` · ${ai.data.untouched.toLocaleString()} not contacted yet` : ""} · ${ai.data.stale.toLocaleString()} outdated`}
              </p>
              {ai.data?.lastAnalyzedAt && (
                <p className="mt-1 text-muted-foreground">
                  Last checked: {new Date(ai.data.lastAnalyzedAt).toLocaleString()}
                </p>
              )}
              {(!aiConfiguration.data?.configured || aiConfiguration.isError) &&
                !aiConfiguration.isPending && (
                  <p className="mt-1 font-medium text-amber-700 dark:text-amber-400">
                    {aiConfiguration.data?.message ??
                      "Quo setup required or service unavailable. No AI outcomes have been assumed."}
                  </p>
                )}
              {aiConfiguration.data?.configured && (
                <p className="mt-1 text-muted-foreground">
                  Quo connected · {aiConfiguration.data.phoneNumberCount} inboxes ·{" "}
                  {aiConfiguration.data.phoneNumberSource === "discovered"
                    ? "IDs discovered automatically"
                    : "Inbox allowlist active"}
                </p>
              )}
              {Boolean(progress.data?.pending) && (
                <p className="mt-1 font-medium text-sky-700 dark:text-sky-300" role="status">
                  {progress.data!.pending} leads syncing · {progress.data!.workDone}/
                  {progress.data!.workTotal} inbox checks for pending leads. Sync resumes
                  automatically; partial history is never counted.
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                refreshAi.isPending ||
                Boolean(progress.data?.pending) ||
                !aiConfiguration.data?.configured ||
                ai.isError
              }
              onClick={() => {
                void ai.refetch();
                void cs.refetch();
                refreshAi.mutate({ ...range });
              }}
              title="Check every eligible lead in the selected range; each lead is checked at most once every 15 minutes"
            >
              <RefreshCw
                className={cn("mr-1.5 h-3.5 w-3.5", refreshAi.isPending && "animate-spin")}
              />
              {refreshAi.isPending ? "Checking Quo…" : "Refresh AI · next 5 leads"}
            </Button>
          </div>
        )}
        <Grid>
          {CS_STATUSES.map((k) => (
            <StatCard
              key={k}
              label={CS_LABELS[k] ?? k.replace(/_/g, " ")}
              value={cs.data?.[k] ?? 0}
              total={csTotal}
              color={CS_STATUS_COLORS[k]}
              aiValue={
                !canSeeAiReporting || k === "need_follow_up"
                  ? undefined
                  : ai.data && !ai.isError
                    ? (ai.data.counts[k] ?? 0)
                    : null
              }
            />
          ))}
        </Grid>
        {ai.data?.samples && ai.data.samples.length > 0 && !ai.isError && (
          <div className="mt-4 overflow-x-auto rounded-xl border">
            <table className="crm-data-table w-full text-xs">
              <caption className="p-3 text-left text-xs text-muted-foreground">
                Latest disagreements / reviews (up to 10). A disagreement is not proof that AI is
                correct.
              </caption>
              <thead>
                <tr>
                  <th className="p-2 text-left">Lead</th>
                  <th className="p-2 text-left">Manual</th>
                  <th className="p-2 text-left">AI status</th>
                  <th className="p-2 text-left">Confidence / reason</th>
                </tr>
              </thead>
              <tbody>
                {ai.data.samples.map((sample) => (
                  <tr key={sample.leadId} className="border-t">
                    <td className="p-2">
                      <Link
                        to="/app/cs-leads"
                        search={{ leadId: sample.leadId }}
                        className="text-primary underline"
                      >
                        {sample.customerName || "Open lead"}
                      </Link>
                    </td>
                    <td className="p-2">
                      {STATUS_LABEL[sample.manualStatus] ?? sample.manualStatus}
                    </td>
                    <td className="p-2">
                      {sample.aiStatus
                        ? (STATUS_LABEL[sample.aiStatus] ?? sample.aiStatus)
                        : "Needs review"}
                    </td>
                    <td className="p-2">
                      {sample.confidence === null ? "—" : `${Math.round(sample.confidence * 100)}%`}{" "}
                      · {sample.reasonCode.replace(/_/g, " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ─── Leads Forwarded Per User ─── */}
      {canSeeForwardedByUser && (
        <ForwardedByUserSection range={range} preset={preset} csCounts={cs.data} />
      )}

      {/* ─── Number-Not-Found Checks Per User ─── */}
      <Section
        title="Number-not-found checks per user"
        subtitle="Raw leads marked as Number not found in range"
        badge={`${notFoundRows.length} user${notFoundRows.length === 1 ? "" : "s"}`}
      >
        <div className="crm-surface-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b bg-muted/20">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchNotFound}
                onChange={(e) => setSearchNotFound(e.target.value)}
                placeholder="Search user..."
                className="h-8 pl-8 pr-7 text-xs bg-background"
              />
              {searchNotFound && (
                <button
                  type="button"
                  onClick={() => setSearchNotFound("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Total marked not found:{" "}
              <span className="font-semibold text-foreground tabular-nums">
                {notFoundRows.reduce((acc, r) => acc + r.not_found_count, 0).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="max-h-[420px] overflow-auto">
            <table className="crm-data-table">
              <thead className="bg-muted/40 sticky top-0">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium text-right">Marked Not Found</th>
                </tr>
              </thead>
              <tbody>
                {notFoundByUser.isLoading && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2 text-primary" />
                      Loading user checks…
                    </td>
                  </tr>
                )}
                {!notFoundByUser.isLoading && notFoundRows.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground text-xs">
                      {searchNotFound
                        ? "No matching users found."
                        : "No Number not found marks in this range."}
                    </td>
                  </tr>
                )}
                {notFoundRows.map((r, i) => (
                  <tr
                    key={r.user_id ?? `unknown-${i}`}
                    className="border-t hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-2.5 font-medium">
                      <div className="flex items-center gap-2.5">
                        <div className="h-7 w-7 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center text-xs font-bold shrink-0">
                          {getInitials(r.user_name)}
                        </div>
                        <span className="truncate">{r.user_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {r.user_email ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-500">
                        {r.not_found_count.toLocaleString()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      {/* ─── Per-Person Leads by Service ─── */}
      <PersonServiceReport range={range} />
    </div>
  );
}

function Section({
  title,
  subtitle,
  badge,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="crm-section-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h2 className="crm-section-title">{title}</h2>
          {subtitle && <p className="crm-card-label mt-0.5">{subtitle}</p>}
        </div>
        {badge && (
          <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground">
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">{children}</div>;
}

function StatCard({
  label,
  value,
  total,
  color,
  aiValue,
}: {
  label: string;
  value: number;
  total?: number;
  color?: string;
  aiValue?: number | null;
}) {
  const pct = total && total > 0 ? ((value / total) * 100).toFixed(1) : null;
  return (
    <div className="crm-surface-card p-4 hover:border-primary/40 transition-colors flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
          {color && (
            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          )}
        </div>
        <div className="text-2xl font-bold tabular-nums text-foreground mt-2">
          {value.toLocaleString()}
        </div>
      </div>
      {pct !== null && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
            <span>Share</span>
            <span className="tabular-nums font-medium">{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${pct}%`,
                backgroundColor: color ?? "var(--color-primary)",
              }}
            />
          </div>
        </div>
      )}
      {aiValue !== undefined && (
        <div
          className="mt-3 flex items-center justify-end gap-1.5 text-xs text-sky-700 dark:text-sky-300"
          title="Latest valid AI classification count in the same assigned-date range; separate from manual totals"
        >
          <span className="rounded-full border border-sky-500/60 px-1 py-0.5 text-[9px] font-bold">
            AI
          </span>
          <span className="text-[10px]">AI status</span>
          <strong className="tabular-nums">
            {aiValue === null ? "—" : aiValue.toLocaleString()}
          </strong>
        </div>
      )}
    </div>
  );
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (name.slice(0, 2) || "??").toUpperCase();
}

type RangeResult = { from: string | null; to: string | null };

// ─── Leads Forwarded Per User Report ──────────────────────────────────────────
export type ForwardedUserRow = {
  user_id: string | null;
  user_name: string;
  user_email: string | null;
  forwarded_count: number;
  status_counts: Record<string, number>;
};

function ForwardedByUserSection({
  range,
  preset,
  csCounts,
}: {
  range: RangeResult;
  preset: DatePreset;
  csCounts?: Record<string, number>;
}) {
  const [searchUser, setSearchUser] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<CsStatus | "__all__">("__all__");
  const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(new Set());

  const byUserQuery = useQuery({
    queryKey: ["report-forwarded-by-user", range.from, range.to],
    queryFn: async (): Promise<ForwardedUserRow[]> => {
      const { data, error } = await (supabase.rpc as CallableFunction)(
        "report_leads_forwarded_by_user",
        {
          _from: range.from ?? undefined,
          _to: range.to ?? undefined,
        },
      );
      if (error) throw error;
      const rows = (data ?? []) as {
        user_id?: string;
        user_name?: string;
        user_email?: string;
        forwarded_count?: number;
        status_counts?: Record<string, number>;
      }[];
      return rows
        .map((r) => ({
          user_id: r.user_id ?? null,
          user_name: r.user_name || "(unknown)",
          user_email: r.user_email ?? null,
          forwarded_count: Number(r.forwarded_count || 0),
          status_counts: r.status_counts ?? {},
        }))
        .filter((u) => {
          if (!u.user_id) return false;
          const name = u.user_name.trim().toLowerCase();
          if (
            !name ||
            name === "(unknown)" ||
            name === "unknown" ||
            name.startsWith("unknown user")
          )
            return false;
          return true;
        });
    },
  });

  // Exclude Customer Service accounts by their actual role rather than by
  // guessing from names/emails — name heuristics were dropping legitimate
  // forwarders (operations staff) whose names happened to contain "cs".
  const csIdsQuery = useQuery({
    queryKey: ["forwarded-cs-user-ids"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["cs", "cs_admin"]);
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.user_id));
    },
    staleTime: 10 * 60_000,
  });

  const rawUsers = useMemo(() => {
    const csIds = csIdsQuery.data;
    const rows = byUserQuery.data ?? [];
    // Until the role list loads, exclude only clearly CS-named accounts so we
    // never leak CS rows; once it loads, filter authoritatively by role.
    return rows.filter((u) =>
      csIds
        ? !(u.user_id && csIds.has(u.user_id))
        : !isCsUser({ user_id: u.user_id, full_name: u.user_name, email: u.user_email }),
    );
  }, [byUserQuery.data, csIdsQuery.data]);
  const totalForwardedAll = useMemo(
    () => rawUsers.reduce((sum, u) => sum + u.forwarded_count, 0),
    [rawUsers],
  );

  // Compute status totals across all users
  const aggregatedStatusTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const st of CS_STATUSES) {
      const fromUsers = rawUsers.reduce((sum, u) => sum + (u.status_counts[st] ?? 0), 0);
      totals[st] = fromUsers > 0 ? fromUsers : (csCounts?.[st] ?? 0);
    }
    return totals;
  }, [rawUsers, csCounts]);

  const toggleExpand = (id: string) => {
    setExpandedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isAllExpanded = rawUsers.length > 0 && expandedUserIds.size === rawUsers.length;
  const toggleExpandAll = () => {
    if (isAllExpanded) {
      setExpandedUserIds(new Set());
    } else {
      setExpandedUserIds(new Set(rawUsers.map((u, i) => u.user_id ?? `unknown-${i}`)));
    }
  };

  // Filter and sort users
  const filteredUsers = useMemo(() => {
    let list = [...rawUsers];

    // Filter by search
    if (searchUser.trim()) {
      const q = searchUser.toLowerCase();
      list = list.filter(
        (u) =>
          u.user_name.toLowerCase().includes(q) ||
          (u.user_email && u.user_email.toLowerCase().includes(q)),
      );
    }

    // Sort by selected status or forwarded count
    if (selectedStatus !== "__all__") {
      list.sort((a, b) => {
        const countA = a.status_counts[selectedStatus] ?? 0;
        const countB = b.status_counts[selectedStatus] ?? 0;
        if (countB !== countA) return countB - countA;
        return b.forwarded_count - a.forwarded_count;
      });
    } else {
      list.sort((a, b) => b.forwarded_count - a.forwarded_count);
    }

    return list;
  }, [rawUsers, searchUser, selectedStatus]);

  function exportUserBreakdownCsv() {
    downloadCsv(
      `leads-forwarded-per-user-${preset}.csv`,
      ["User Name", "Email", "Total Forwarded", ...CS_STATUSES.map((st) => CS_LABELS[st] ?? st)],
      filteredUsers.map((u) => [
        u.user_name,
        u.user_email ?? "—",
        u.forwarded_count,
        ...CS_STATUSES.map((st) => u.status_counts[st] ?? 0),
      ]),
    );
  }

  const activeStatusCount =
    selectedStatus !== "__all__" ? (aggregatedStatusTotals[selectedStatus] ?? 0) : null;

  return (
    <Section
      title="Leads forwarded per user"
      subtitle="Qualified leads assigned in selected range with lead status breakdown"
      badge={`${rawUsers.length} user${rawUsers.length === 1 ? "" : "s"}`}
    >
      <div className="crm-surface-card overflow-hidden space-y-3">
        {/* Status Pill Tabs (Matching CS Pipeline screenshot) */}
        <div className="px-4 pt-3 pb-2 border-b bg-muted/10">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Lead Status Breakdown
            </span>
            {selectedStatus !== "__all__" && (
              <button
                type="button"
                onClick={() => setSelectedStatus("__all__")}
                className="text-xs text-primary hover:underline font-medium cursor-pointer"
              >
                Reset to all leads
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 scrollbar-thin">
            {/* All Leads button */}
            <button
              type="button"
              onClick={() => setSelectedStatus("__all__")}
              className={cn(
                "px-3 h-8 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 transition-all shrink-0 cursor-pointer",
                selectedStatus === "__all__"
                  ? "bg-primary text-primary-foreground shadow-sm font-semibold"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  selectedStatus === "__all__" ? "bg-primary-foreground" : "bg-muted-foreground",
                )}
              />
              All Leads
              <span
                className={cn(
                  "text-[10.5px] tabular-nums font-semibold",
                  selectedStatus === "__all__"
                    ? "text-primary-foreground/90"
                    : "text-muted-foreground",
                )}
              >
                {totalForwardedAll.toLocaleString()}
              </span>
            </button>

            {/* Status buttons */}
            {CS_STATUSES.map((st) => {
              const count = aggregatedStatusTotals[st] ?? 0;
              const isSelected = selectedStatus === st;
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => setSelectedStatus(isSelected ? "__all__" : st)}
                  className={cn(
                    "px-2.5 h-8 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 transition-all shrink-0 cursor-pointer",
                    isSelected
                      ? "bg-primary/20 text-primary border border-primary/40 shadow-xs font-semibold ring-1 ring-primary/30"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", statusDotTone(st))} />
                  <span>{CS_LABELS[st] ?? st}</span>
                  <span
                    className={cn(
                      "text-[10.5px] tabular-nums",
                      isSelected ? "text-primary font-bold" : "text-muted-foreground",
                    )}
                  >
                    {count.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Toolbar: Search, Expand All, Export CSV, Counters */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchUser}
                onChange={(e) => setSearchUser(e.target.value)}
                placeholder="Search user by name or email..."
                className="h-8 pl-8 pr-7 text-xs bg-background"
              />
              {searchUser && (
                <button
                  type="button"
                  onClick={() => setSearchUser("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs"
              onClick={toggleExpandAll}
              title={isAllExpanded ? "Collapse all rows" : "Expand all rows"}
            >
              {isAllExpanded ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5 mr-1" />
                  Collapse all
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5 mr-1" />
                  Expand all
                </>
              )}
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs ml-auto sm:ml-0"
              onClick={exportUserBreakdownCsv}
              title="Export complete per-user lead status breakdown to CSV"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export CSV
            </Button>
          </div>

          <div className="text-xs text-muted-foreground">
            {selectedStatus !== "__all__" ? (
              <span>
                {CS_LABELS[selectedStatus] ?? selectedStatus}:{" "}
                <span className="font-bold text-primary tabular-nums">
                  {activeStatusCount?.toLocaleString()}
                </span>{" "}
                of{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {totalForwardedAll.toLocaleString()}
                </span>{" "}
                total forwarded
              </span>
            ) : (
              <span>
                Total forwarded:{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {totalForwardedAll.toLocaleString()}
                </span>
              </span>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="max-h-[560px] overflow-auto">
          <table className="crm-data-table w-full">
            <thead className="bg-muted/40 sticky top-0 z-10">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium hidden md:table-cell">
                  Lead Status Breakdown
                </th>
                <th className="px-4 py-2.5 font-medium text-right">Forwarded Leads</th>
              </tr>
            </thead>
            <tbody>
              {byUserQuery.isLoading && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2 text-primary" />
                    Loading forwarded leads per user…
                  </td>
                </tr>
              )}
              {!byUserQuery.isLoading && byUserQuery.isError && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-destructive text-xs">
                    Couldn't load forwarded leads: {friendlyError(byUserQuery.error)}
                  </td>
                </tr>
              )}
              {!byUserQuery.isLoading && !byUserQuery.isError && filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-muted-foreground text-xs">
                    {searchUser ? "No matching users found." : "No leads forwarded in this range."}
                  </td>
                </tr>
              )}
              {filteredUsers.map((u, i) => {
                const rowId = u.user_id ?? `unknown-${i}`;
                const isExpanded = expandedUserIds.has(rowId);
                return (
                  <UserForwardedRow
                    key={rowId}
                    user={u}
                    isExpanded={isExpanded}
                    onToggleExpand={() => toggleExpand(rowId)}
                    selectedStatus={selectedStatus}
                    totalForwardedAll={totalForwardedAll}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

function UserForwardedRow({
  user,
  isExpanded,
  onToggleExpand,
  selectedStatus,
  totalForwardedAll,
}: {
  user: ForwardedUserRow;
  isExpanded: boolean;
  onToggleExpand: () => void;
  selectedStatus: CsStatus | "__all__";
  totalForwardedAll: number;
}) {
  const statusCounts = user.status_counts;

  const processedCount = statusCounts["converted"] ?? 0;
  const undeliverCount = statusCounts["undeliver"] ?? 0;
  const wrongNumberCount = statusCounts["wrong_number"] ?? 0;
  const wrongLeadCount = statusCounts["wrong_lead"] ?? 0;
  const needFollowUpCount = statusCounts["need_follow_up"] ?? 0;
  const newCount = statusCounts["new"] ?? 0;

  const total = user.forwarded_count || 1;
  const processedPct = ((processedCount / total) * 100).toFixed(1);
  const qualityIssuesCount =
    (statusCounts["undeliver"] ?? 0) +
    (statusCounts["wrong_number"] ?? 0) +
    (statusCounts["wrong_lead"] ?? 0);
  const issuesPct = ((qualityIssuesCount / total) * 100).toFixed(1);

  const selectedCount = selectedStatus !== "__all__" ? (statusCounts[selectedStatus] ?? 0) : null;
  const selectedPct = selectedCount !== null ? ((selectedCount / total) * 100).toFixed(1) : null;

  return (
    <>
      <tr
        onClick={onToggleExpand}
        className={cn(
          "border-t hover:bg-muted/30 transition-colors cursor-pointer select-none",
          isExpanded && "bg-muted/25 border-b-0",
        )}
      >
        {/* Expand Chevron + User Name */}
        <td className="px-4 py-3 font-medium">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              className="p-1 -ml-1 text-muted-foreground hover:text-foreground rounded-md transition-colors cursor-pointer"
              aria-label={isExpanded ? "Collapse row" : "Expand row"}
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 transition-transform duration-200",
                  isExpanded && "rotate-90 text-primary",
                )}
              />
            </button>
            <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0 border border-primary/20">
              {getInitials(user.user_name)}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm text-foreground truncate flex items-center gap-1.5">
                <span>{user.user_name}</span>
                {selectedCount !== null && selectedCount > 0 && (
                  <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-primary/15 text-primary">
                    {selectedCount} {CS_LABELS[selectedStatus] ?? selectedStatus}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">{user.user_email ?? "—"}</div>
            </div>
          </div>
        </td>

        {/* Lead Status Proportional Bar & Top Status Tags */}
        <td className="px-4 py-3 hidden md:table-cell">
          <div className="space-y-1.5 max-w-md">
            {/* Visual ratio bar */}
            <div className="h-2 w-full rounded-full bg-muted/60 overflow-hidden flex shadow-inner">
              {processedCount > 0 && (
                <div
                  title={`Delivered: ${processedCount} (${processedPct}%)`}
                  style={{ width: `${(processedCount / total) * 100}%` }}
                  className="h-full bg-emerald-500 transition-all duration-300"
                />
              )}
              {qualityIssuesCount > 0 && (
                <div
                  title={`Quality issues: ${qualityIssuesCount} (${issuesPct}%)`}
                  style={{ width: `${(qualityIssuesCount / total) * 100}%` }}
                  className="h-full bg-rose-500 transition-all duration-300"
                />
              )}
              {needFollowUpCount > 0 && (
                <div
                  title={`Need follow-up: ${needFollowUpCount}`}
                  style={{ width: `${(needFollowUpCount / total) * 100}%` }}
                  className="h-full bg-sky-500 transition-all duration-300"
                />
              )}
              {newCount > 0 && (
                <div
                  title={`New to contact: ${newCount}`}
                  style={{ width: `${(newCount / total) * 100}%` }}
                  className="h-full bg-sky-400 opacity-60 transition-all duration-300"
                />
              )}
            </div>

            {/* Quick mini pills */}
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              {processedCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Delivered:{" "}
                  <strong className="tabular-nums">{processedCount.toLocaleString()}</strong>
                </span>
              )}
              {undeliverCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                  Undeliver:{" "}
                  <strong className="tabular-nums">{undeliverCount.toLocaleString()}</strong>
                </span>
              )}
              {wrongNumberCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                  Wrong #:{" "}
                  <strong className="tabular-nums">{wrongNumberCount.toLocaleString()}</strong>
                </span>
              )}
              {wrongLeadCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                  Wrong Lead:{" "}
                  <strong className="tabular-nums">{wrongLeadCount.toLocaleString()}</strong>
                </span>
              )}
              {needFollowUpCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                  Follow-up:{" "}
                  <strong className="tabular-nums">{needFollowUpCount.toLocaleString()}</strong>
                </span>
              )}
            </div>
          </div>
        </td>

        {/* Forwarded count badge */}
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
          {selectedStatus !== "__all__" ? (
            <div className="flex flex-col items-end">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-primary/15 text-primary border border-primary/20">
                <span className={cn("h-1.5 w-1.5 rounded-full", statusDotTone(selectedStatus))} />
                {selectedCount?.toLocaleString() ?? 0} {CS_LABELS[selectedStatus] ?? selectedStatus}
              </span>
              <span className="text-[11px] text-muted-foreground mt-0.5">
                {selectedPct}% of {user.forwarded_count.toLocaleString()} total
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-end">
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-primary/10 text-primary border border-primary/20 shadow-xs">
                {user.forwarded_count.toLocaleString()}
              </span>
              {totalForwardedAll > 0 && (
                <span className="text-[10px] text-muted-foreground mt-0.5">
                  {((user.forwarded_count / totalForwardedAll) * 100).toFixed(1)}% of all
                </span>
              )}
            </div>
          )}
        </td>
      </tr>

      {/* Expanded Accordion Drawer */}
      {isExpanded && (
        <tr className="bg-muted/15 border-t border-border/50">
          <td colSpan={3} className="px-4 py-4 sm:px-6">
            <div className="space-y-4">
              {/* Summary Stats Row */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-border/80 bg-background/80">
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <div>
                    <span className="text-muted-foreground">Total Forwarded: </span>
                    <strong className="font-bold text-foreground text-sm tabular-nums">
                      {user.forwarded_count.toLocaleString()}
                    </strong>
                  </div>
                  <div className="h-3 w-px bg-border hidden sm:block" />
                  <div>
                    <span className="text-muted-foreground">Delivered Rate: </span>
                    <strong className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {processedPct}%
                    </strong>
                    <span className="text-muted-foreground text-[11px] ml-1">
                      ({processedCount.toLocaleString()})
                    </span>
                  </div>
                  <div className="h-3 w-px bg-border hidden sm:block" />
                  <div>
                    <span className="text-muted-foreground">Quality Issues: </span>
                    <strong className="font-semibold text-rose-600 dark:text-rose-400 tabular-nums">
                      {issuesPct}%
                    </strong>
                    <span className="text-muted-foreground text-[11px] ml-1">
                      ({qualityIssuesCount.toLocaleString()})
                    </span>
                  </div>
                </div>

                {user.user_id && (
                  <Link
                    to="/app/forwarded-leads"
                    search={{ forwardedByFilter: user.user_id } as Record<string, unknown>}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                  >
                    View forwarded leads
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </div>

              {/* Status Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
                {CS_STATUSES.map((st) => {
                  const count = statusCounts[st] ?? 0;
                  const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
                  const isSelected = selectedStatus === st;
                  return (
                    <div
                      key={st}
                      className={cn(
                        "p-2.5 rounded-lg border text-left transition-all",
                        isSelected
                          ? "border-primary bg-primary/10 shadow-xs ring-1 ring-primary/30"
                          : "border-border/60 bg-background/50 hover:bg-background hover:border-border",
                      )}
                    >
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={cn("h-2 w-2 rounded-full shrink-0", statusDotTone(st))}
                          />
                          <span className="text-[11px] font-medium text-muted-foreground truncate">
                            {CS_LABELS[st] ?? st}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between mt-1">
                        <span
                          className={cn(
                            "text-base font-bold tabular-nums",
                            count > 0 ? "text-foreground" : "text-muted-foreground/60",
                          )}
                        >
                          {count.toLocaleString()}
                        </span>
                        <span className="text-[10.5px] tabular-nums text-muted-foreground font-medium">
                          {pct}%
                        </span>
                      </div>
                      <div className="h-1 w-full rounded-full bg-muted/50 overflow-hidden mt-1.5">
                        <div
                          className={cn("h-full rounded-full", statusDotTone(st))}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Per-Person Leads by Service Report ───────────────────────────────────────

const DEPT_COLORS: Record<string, string> = {
  maturing: "var(--color-chart-1)",
  sub_admin: "var(--color-chart-2)",
  seo: "var(--color-chart-3)",
  facebook: "var(--color-chart-4)",
  scraping: "var(--color-chart-5)",
  acc_handler: "var(--color-primary-glow)",
};

function PersonServiceReport({ range }: { range: RangeResult }) {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Load all active profiles once (excluding Customer Support CS users)
  const profiles = useQuery({
    queryKey: ["report-profiles-list"],
    queryFn: async () => {
      const [profsRes, rolesRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .eq("is_active", true)
          .order("full_name"),
        supabase.from("user_roles").select("user_id, role").in("role", ["cs", "cs_admin"]),
      ]);

      if (profsRes.error) throw profsRes.error;
      const csIds = new Set((rolesRes.data ?? []).map((r) => r.user_id));
      const list = (profsRes.data ?? []) as Array<{
        user_id: string;
        full_name: string;
        email: string;
      }>;
      return list.filter((p) => !isCsUser(p, csIds));
    },
    staleTime: 10 * 60_000,
  });

  const allProfiles = useMemo(() => profiles.data ?? [], [profiles.data]);
  const filteredProfiles = useMemo(
    () =>
      allProfiles.filter(
        (p) =>
          p.full_name.toLowerCase().includes(search.toLowerCase()) ||
          p.email.toLowerCase().includes(search.toLowerCase()),
      ),
    [allProfiles, search],
  );

  const selectedProfile = allProfiles.find((p) => p.user_id === selectedUserId);

  // Query leads by service for the selected user + date range
  const leadsQuery = useQuery({
    queryKey: ["report-person-service", selectedUserId, range.from, range.to],
    enabled: !!selectedUserId,
    queryFn: async () => {
      let q = supabase
        .from("qualified_leads")
        .select("service, submitted_by_role")
        .eq("created_by", selectedUserId!);
      if (range.from) q = q.gte("created_at", range.from);
      if (range.to) q = q.lt("created_at", range.to);
      const { data, error } = await q;
      if (error) throw error;

      // Count by service client-side
      const counts: Record<string, number> = {};
      let dept = "";
      for (const row of data ?? []) {
        const svc = (row.service ?? "").trim() || "(no service)";
        counts[svc] = (counts[svc] ?? 0) + 1;
        if (!dept && row.submitted_by_role) dept = row.submitted_by_role;
      }
      const rows = Object.entries(counts)
        .map(([service, count]) => ({ service, count }))
        .sort((a, b) => b.count - a.count);
      return { rows, dept, total: rows.reduce((s, r) => s + r.count, 0) };
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  const result = leadsQuery.data;
  const rows = result?.rows ?? [];
  const maxCount = rows[0]?.count ?? 1;
  const barColor = result?.dept
    ? (DEPT_COLORS[result.dept] ?? "var(--color-primary)")
    : "var(--color-primary)";

  function exportPersonCsv() {
    if (!result || !selectedProfile) return;
    downloadCsv(
      `leads-by-service-${selectedProfile.full_name.replace(/\s+/g, "-")}.csv`,
      ["Rank", "Service", "Lead Count", "Share %"],
      rows.map((r, i) => [
        i + 1,
        r.service,
        r.count,
        result.total ? ((r.count / result.total) * 100).toFixed(1) + "%" : "—",
      ]),
    );
  }

  return (
    <Section title="Leads by Service — Per Person">
      <div className="crm-surface-card">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
          {/* Person picker dropdown with Radix Popover (portaled, solid background) */}
          <Popover open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <PopoverTrigger asChild>
              <button
                id="person-service-picker"
                type="button"
                className={cn(
                  "flex items-center justify-between gap-2 h-9 px-3 rounded-md border text-sm transition-colors cursor-pointer",
                  "bg-background hover:bg-muted/50 border-border min-w-[240px] text-left",
                  dropdownOpen && "ring-2 ring-primary/40 border-primary",
                )}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate text-sm font-medium">
                    {selectedProfile ? selectedProfile.full_name : "Select a person…"}
                  </span>
                </div>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-150",
                    dropdownOpen && "rotate-180",
                  )}
                />
              </button>
            </PopoverTrigger>

            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-80 p-0 rounded-xl border border-border shadow-2xl z-[9999] overflow-hidden"
              style={{ backgroundColor: "var(--color-card, #17171a)", opacity: 1 }}
            >
              <div
                className="p-2 border-b border-border"
                style={{ backgroundColor: "var(--color-card, #17171a)" }}
              >
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    id="person-search-input"
                    autoFocus
                    placeholder="Search name or email…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-8 pr-7 py-1.5 text-sm bg-muted/60 text-foreground placeholder:text-muted-foreground rounded-md outline-none border border-border/50 focus:border-primary/60"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <ul
                className="max-h-64 overflow-y-auto py-1"
                style={{ backgroundColor: "var(--color-card, #17171a)" }}
              >
                {profiles.isLoading && (
                  <li className="px-3 py-3 text-xs text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Loading users…
                  </li>
                )}
                {!profiles.isLoading && filteredProfiles.length === 0 && (
                  <li className="px-3 py-3 text-xs text-muted-foreground text-center">
                    No users found
                  </li>
                )}
                {filteredProfiles.map((p) => (
                  <li
                    key={p.user_id}
                    onClick={() => {
                      setSelectedUserId(p.user_id);
                      setDropdownOpen(false);
                      setSearch("");
                    }}
                    className={cn(
                      "flex flex-col px-3 py-2 cursor-pointer transition-colors text-sm hover:bg-muted/80",
                      p.user_id === selectedUserId && "bg-primary/20 text-primary font-medium",
                    )}
                  >
                    <span className="font-medium text-foreground">{p.full_name}</span>
                    <span className="text-xs text-muted-foreground">{p.email}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>

          {/* Summary badge + export button */}
          {result && (
            <>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground tabular-nums">{result.total}</span>{" "}
                leads
                {result.dept && (
                  <>
                    {" "}
                    ·{" "}
                    <span
                      className="font-semibold capitalize px-1.5 py-0.5 rounded-md"
                      style={{ background: `${barColor}20`, color: barColor }}
                    >
                      {result.dept.replace(/_/g, " ")}
                    </span>
                  </>
                )}{" "}
                · {rows.length} service{rows.length !== 1 ? "s" : ""}
              </div>
              <Button size="sm" variant="outline" className="h-8 ml-auto" onClick={exportPersonCsv}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export CSV
              </Button>
            </>
          )}
        </div>

        {/* Body */}
        {!selectedUserId ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            Select a person above to see their leads broken down by service.
            <br />
            <span className="text-xs opacity-60 mt-1 block">
              Uses the date range selected at the top of the page.
            </span>
          </div>
        ) : leadsQuery.isLoading ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground animate-pulse">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            No leads found for <strong>{selectedProfile?.full_name}</strong> in this date range.
          </div>
        ) : (
          <div className="overflow-auto max-h-[560px]">
            <table className="crm-data-table w-full">
              <thead className="bg-muted/40 sticky top-0">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium w-8">#</th>
                  <th className="px-4 py-2.5 font-medium">Service</th>
                  <th className="px-4 py-2.5 font-medium">Volume</th>
                  <th className="px-4 py-2.5 font-medium text-right w-20">Leads</th>
                  <th className="px-4 py-2.5 font-medium text-right w-16">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const pct = result ? (r.count / result.total) * 100 : 0;
                  const barW = (r.count / maxCount) * 100;
                  return (
                    <tr key={r.service} className="border-t hover:bg-muted/20">
                      <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2.5 text-sm font-medium">
                        <span className="block max-w-[280px] truncate">{r.service}</span>
                      </td>
                      <td className="px-4 py-2.5 min-w-[160px]">
                        <div className="h-2 rounded-full bg-muted/40 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${barW}%`,
                              background: `linear-gradient(90deg, ${barColor}, var(--color-primary-glow))`,
                            }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-sm">
                        {r.count.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                        {pct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-muted/20 border-t-2 border-border">
                <tr>
                  <td colSpan={3} className="px-4 py-2.5 text-xs text-muted-foreground font-medium">
                    Total · {rows.length} service{rows.length !== 1 ? "s" : ""}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold">
                    {result?.total.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
