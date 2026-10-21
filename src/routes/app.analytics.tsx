import { createFileRoute } from "@tanstack/react-router";
import { RouteSkeleton } from "@/components/route-skeleton";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { addDays, differenceInCalendarDays, format, subDays, startOfDay } from "date-fns";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
  ComposedChart,
  Line,
  LabelList,
  ReferenceLine,
} from "recharts";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Filter,
  Layers,
  Loader2,
  MapPin,
  Minus,
  Search,
  X,
} from "lucide-react";
import { US_STATE_NAME } from "@/lib/us-states";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { isCsUser } from "@/lib/cs-filter";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics \u00b7 JellyBean" },
      {
        name: "description",
        content: "Review JellyBean pipeline throughput and team performance.",
      },
      { property: "og:title", content: "Analytics \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Review JellyBean pipeline throughput and team performance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
});

type CsStatus = Database["public"]["Enums"]["cs_status"];

// ─── Department config ────────────────────────────────────────────────────────
type DeptKey = "maturing" | "sub_admin" | "seo" | "facebook";

const DEPARTMENTS: { key: DeptKey; label: string; color: string }[] = [
  { key: "maturing", label: "Maturing", color: "var(--color-chart-1)" },
  { key: "sub_admin", label: "Sub Admin", color: "var(--color-chart-2)" },
  { key: "seo", label: "SEO", color: "var(--color-chart-3)" },
  { key: "facebook", label: "Facebook", color: "var(--color-chart-4)" },
];

const CS_STATUSES = [
  "new",
  "undeliver",
  "wrong_number",
  "wrong_lead",
  "already_got_someone",
  "service_provider_himself",
  "converted",
  "cx_interested",
  "cx_not_interested",
  "cx_didnt_replied",
  "need_follow_up",
] as const satisfies readonly CsStatus[];

const CS_LABELS: Record<string, string> = {
  new: "New to contact",
  undeliver: "Undeliver",
  wrong_number: "Wrong number",
  wrong_lead: "Wrong lead",
  already_got_someone: "Already got someone",
  service_provider_himself: "Service provider himself",
  converted: "Delivered",
  cx_interested: "CX interested",
  cx_not_interested: "CX not interested",
  cx_didnt_replied: "CX didn't replied",
  need_follow_up: "Need follow-up",
};

const PIE_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-primary-glow)",
  "var(--color-success)",
  "var(--color-warning)",
];

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Pipeline health, throughput, and top performers."
      />
      <PageBody>
        <RoleGate allow={["admin", "sub_admin"]} current={auth.primaryRole}>
          <Inner isAdmin={auth.primaryRole === "admin" || auth.primaryRole === "sub_admin"} />
        </RoleGate>
      </PageBody>
    </div>
  );
}

type DailyRow = {
  day: string;
  key: string;
  start: string;
  end: string;
  captured: number;
  forwarded: number;
  wrong: number;
  sentToCS: number;
};

async function fetchDailySeries(fromISO: string, toISO: string, startDate: Date, endDate: Date) {
  const daysCount = Math.max(
    1,
    Math.min(180, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000)),
  );
  const days: DailyRow[] = Array.from({ length: daysCount }, (_, i) => {
    const d = addDays(startDate, i);
    return {
      day: format(d, "MMM d"),
      key: format(d, "yyyy-MM-dd"),
      start: d.toISOString(),
      end: addDays(d, 1).toISOString(),
      captured: 0,
      forwarded: 0,
      wrong: 0,
      sentToCS: 0,
    };
  });
  const { data, error } = await supabase.rpc("get_analytics_daily_stats", {
    _start_date: fromISO,
    _end_date: toISO,
  });
  if (error) throw error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statsMap = new Map((data ?? []).map((row: any) => [row.day_key, row]));
  days.forEach((day) => {
    const dbRow = statsMap.get(day.key);
    if (dbRow) {
      day.captured = Number(dbRow.total_captured);
      day.forwarded = Number(dbRow.forwarded_count);
      day.wrong = Number(dbRow.wrong_count);
      day.sentToCS = Number(dbRow.sent_to_cs_count);
    }
  });
  return days;
}

function Inner({ isAdmin }: { isAdmin: boolean }) {
  const today = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);
  const defaultFrom = useMemo(() => format(startOfDay(subDays(new Date(), 29)), "yyyy-MM-dd"), []);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(today);
  const range = useMemo(() => {
    const start = startOfDay(new Date(`${fromDate}T00:00:00`));
    const end = addDays(startOfDay(new Date(`${toDate || fromDate}T00:00:00`)), 1);
    const days = Math.max(1, differenceInCalendarDays(end, start));
    const prevStart = subDays(start, days);
    return {
      start,
      end,
      days,
      since: start.toISOString(),
      until: end.toISOString(),
      prevStart,
      prevSince: prevStart.toISOString(),
      prevUntil: start.toISOString(),
    };
  }, [fromDate, toDate]);

  const analytics = useQuery({
    queryKey: ["analytics-v2", range.since, range.until],
    queryFn: async () => {
      const [series, prevSeries, csResults, forwardersRes] = await Promise.all([
        fetchDailySeries(range.since, range.until, range.start, range.end),
        fetchDailySeries(range.prevSince, range.prevUntil, range.prevStart, range.start),
        Promise.all(
          CS_STATUSES.map((status) =>
            supabase
              .from("qualified_leads")
              .select("id", { count: "exact", head: true })
              .eq("cs_status", status)
              .gte("assigned_at", range.since)
              .lt("assigned_at", range.until),
          ),
        ),
        isAdmin
          ? supabase.rpc("report_leads_forwarded_by_maturing", {
              _from: range.since,
              _to: range.until,
            })
          : Promise.resolve({ data: [], error: null }),
      ]);

      const csBuckets = csResults
        .map((result, index) => {
          if (result.error) throw result.error;
          return {
            key: CS_STATUSES[index],
            status: CS_LABELS[CS_STATUSES[index]] ?? CS_STATUSES[index].replace(/_/g, " "),
            count: result.count ?? 0,
          };
        })
        .filter((b) => b.count > 0)
        .sort((a, b) => b.count - a.count);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawForwarders = (forwardersRes.data ?? []) as any[];
      const forwarders = rawForwarders.filter((f) => {
        const name = (f.user_name || f.maturing_name || "").toLowerCase().trim();
        if (!name || name === "(unknown)" || name === "unknown" || name.startsWith("unknown user"))
          return false;
        return !isCsUser({
          user_id: f.user_id || f.maturing_id,
          full_name: f.user_name || f.maturing_name,
          email: f.user_email || f.maturing_email,
        });
      });

      return { series, prevSeries, csBuckets, forwarders };
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Wrapped so the identity is stable across renders; `?? []` alone allocates a
  // fresh array every render, which defeats every downstream useMemo that
  // depends on these.
  const series = useMemo(() => analytics.data?.series ?? [], [analytics.data]);
  const prevSeries = useMemo(() => analytics.data?.prevSeries ?? [], [analytics.data]);
  const csBuckets = useMemo(() => analytics.data?.csBuckets ?? [], [analytics.data]);
  const forwarders = useMemo(() => analytics.data?.forwarders ?? [], [analytics.data]);

  const totals = useMemo(() => {
    const t = { captured: 0, forwarded: 0, sentToCS: 0, wrong: 0 };
    series.forEach((d) => {
      t.captured += d.captured;
      t.forwarded += d.forwarded;
      t.sentToCS += d.sentToCS;
      t.wrong += d.wrong;
    });
    return t;
  }, [series]);

  const prevTotals = useMemo(() => {
    const t = { captured: 0, forwarded: 0, sentToCS: 0, wrong: 0 };
    prevSeries.forEach((d) => {
      t.captured += d.captured;
      t.forwarded += d.forwarded;
      t.sentToCS += d.sentToCS;
      t.wrong += d.wrong;
    });
    return t;
  }, [prevSeries]);

  const converted = useMemo(
    () => csBuckets.find((b) => b.key === "converted")?.count ?? 0,
    [csBuckets],
  );
  const csTotal = useMemo(() => csBuckets.reduce((s, b) => s + b.count, 0), [csBuckets]);
  const conversionRate = totals.forwarded ? (converted / totals.forwarded) * 100 : 0;

  const bestDay = useMemo(() => {
    if (!series.length) return null;
    return [...series].sort((a, b) => b.captured - a.captured)[0];
  }, [series]);

  const cumulativeSeries = useMemo(() => {
    let cCap = 0;
    let cFwd = 0;
    return series.map((d) => {
      cCap += d.captured;
      cFwd += d.forwarded;
      return { ...d, cumulativeCaptured: cCap, cumulativeForwarded: cFwd };
    });
  }, [series]);

  const funnel = useMemo(() => {
    const captured = totals.captured;
    const forwarded = totals.forwarded;
    const sentToCS = totals.sentToCS;
    const conv = converted;
    return [
      { stage: "Captured", value: captured, pct: 100 },
      {
        stage: "Forwarded",
        value: forwarded,
        pct: captured ? (forwarded / captured) * 100 : 0,
      },
      {
        stage: "Sent to CS",
        value: sentToCS,
        pct: captured ? (sentToCS / captured) * 100 : 0,
      },
      {
        stage: "Converted",
        value: conv,
        pct: captured ? (conv / captured) * 100 : 0,
      },
    ];
  }, [totals, converted]);

  return (
    <div className="space-y-5">
      <div className="crm-toolbar-panel">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value || defaultFrom)}
            className="h-9 w-[150px]"
          />
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value || today)}
            className="h-9 w-[150px]"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => {
              setFromDate(today);
              setToDate(today);
            }}
          >
            Today
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => {
              setFromDate(format(subDays(new Date(), 6), "yyyy-MM-dd"));
              setToDate(today);
            }}
          >
            7d
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => {
              setFromDate(defaultFrom);
              setToDate(today);
            }}
          >
            30d
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => {
              setFromDate(format(subDays(new Date(), 89), "yyyy-MM-dd"));
              setToDate(today);
            }}
          >
            90d
          </Button>
          <div className="ml-auto text-[11px] text-muted-foreground">vs previous {range.days}d</div>
        </div>
      </div>

      {analytics.isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-destructive">Failed to load analytics data</div>
              <div className="text-muted-foreground text-xs mt-1 break-words">
                {(analytics.error as Error)?.message ??
                  "An error occurred while fetching analytics from the server."}
              </div>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => analytics.refetch()}
            disabled={analytics.isFetching}
          >
            {analytics.isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
            Retry
          </Button>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard label="Captured" value={totals.captured} prev={prevTotals.captured} />
        <KpiCard
          label="Forwarded"
          value={totals.forwarded}
          prev={prevTotals.forwarded}
          sub={`${totals.captured ? Math.round((totals.forwarded / totals.captured) * 100) : 0}% of captured`}
        />
        <KpiCard label="Sent to CS" value={totals.sentToCS} prev={prevTotals.sentToCS} />
        <KpiCard
          label="Converted"
          value={converted}
          sub={`${conversionRate.toFixed(1)}% of forwarded`}
          accent="success"
        />
        <KpiCard
          label="Wrong posts"
          value={totals.wrong}
          prev={prevTotals.wrong}
          accent="destructive"
          invertDelta
        />
        <KpiCard
          label="Avg / day"
          value={Math.round(totals.captured / Math.max(1, range.days))}
          sub={bestDay ? `Peak ${bestDay.day} · ${bestDay.captured}` : undefined}
        />
      </div>

      {/* Main flow */}
      <Card title="Lead flow" subtitle="Daily captured, forwarded, sent to CS + cumulative capture">
        <div className="h-80">
          <ResponsiveContainer>
            <ComposedChart
              data={cumulativeSeries}
              margin={{ top: 10, right: 12, left: -10, bottom: 0 }}
            >
              <defs>
                <linearGradient id="gradCap" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.42} />
                  <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradFwd" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-success)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--color-success)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval={Math.max(0, Math.floor(cumulativeSeries.length / 10))}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: "var(--color-muted-foreground)" }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                yAxisId="left"
                type="monotone"
                name="Captured"
                dataKey="captured"
                stroke="var(--color-primary)"
                strokeWidth={2}
                fill="url(#gradCap)"
              />
              <Area
                yAxisId="left"
                type="monotone"
                name="Forwarded"
                dataKey="forwarded"
                stroke="var(--color-success)"
                strokeWidth={2}
                fill="url(#gradFwd)"
              />
              <Bar
                yAxisId="left"
                name="Sent to CS"
                dataKey="sentToCS"
                fill="var(--color-chart-3)"
                radius={[3, 3, 0, 0]}
                barSize={10}
              />
              <Line
                yAxisId="right"
                type="monotone"
                name="Cumulative captured"
                dataKey="cumulativeCaptured"
                stroke="var(--color-primary-glow)"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Funnel + CS donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card
          title="Conversion funnel"
          subtitle="Drop-off from capture to converted"
          className="lg:col-span-2"
        >
          <div className="space-y-3 py-2">
            {funnel.map((f, i) => (
              <div key={f.stage} className="space-y-1">
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="font-semibold tracking-tight">{f.stage}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {f.value.toLocaleString()}{" "}
                    <span className="opacity-60">· {f.pct.toFixed(1)}%</span>
                  </span>
                </div>
                <div className="h-3 rounded-full bg-muted/40 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(0.5, f.pct)}%`,
                      background: `linear-gradient(90deg, var(--color-chart-${(i % 5) + 1}), var(--color-primary-glow))`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="CS pipeline" subtitle={`${csTotal} in queue`}>
          <div className="h-[220px]">
            <ResponsiveContainer>
              <PieChart>
                <Tooltip contentStyle={tooltipStyle} />
                <Pie
                  data={csBuckets}
                  dataKey="count"
                  nameKey="status"
                  innerRadius={52}
                  outerRadius={82}
                  paddingAngle={2}
                  stroke="var(--color-card)"
                  strokeWidth={2}
                >
                  {csBuckets.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1 text-[11.5px]">
            {csBuckets.slice(0, 6).map((b, i) => (
              <li key={b.key} className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                />
                <span className="flex-1 truncate">{b.status}</span>
                <span className="tabular-nums text-muted-foreground">{b.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* ─── Sent to CS Pipeline Analysis (with interactive time & source filters) ─── */}
      <SentToCsSection
        series={series}
        prevSeries={prevSeries}
        since={range.since}
        until={range.until}
      />

      {/* ─── Team Leaderboards (Admin) ─── */}
      {isAdmin && forwarders.length > 0 && (
        <Card title="Top forwarders" subtitle="Qualified leads forwarded by maturing in this range">
          <Leaderboard
            rows={forwarders.map((r) => ({
              label: r.maturing_name ?? "(unknown)",
              sub: r.maturing_email,
              value: Number(r.forwarded_count),
            }))}
            accent="var(--color-primary)"
          />
        </Card>
      )}

      {/* ─── Department Leads by Service ─── */}
      <DeptLeadsChart since={range.since} until={range.until} />
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  fontSize: 12,
  boxShadow: "var(--shadow-md)",
  backdropFilter: "blur(14px)",
};

function KpiCard({
  label,
  value,
  prev,
  sub,
  accent,
  invertDelta,
}: {
  label: string;
  value: number;
  prev?: number;
  sub?: string;
  accent?: "success" | "destructive";
  invertDelta?: boolean;
}) {
  const delta = prev !== undefined ? value - prev : undefined;
  const pct = prev !== undefined && prev > 0 ? ((value - prev) / prev) * 100 : undefined;
  const isUp = delta !== undefined && delta > 0;
  const isDown = delta !== undefined && delta < 0;
  const good = invertDelta ? isDown : isUp;
  const bad = invertDelta ? isUp : isDown;
  return (
    <div className="crm-surface-card p-4">
      <div className="flex items-center justify-between">
        <div className="crm-kicker">{label}</div>
        {delta !== undefined && delta !== 0 && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[10.5px] font-semibold px-1.5 py-0.5 rounded-md tabular-nums",
              good && "bg-success/15 text-success",
              bad && "bg-destructive/15 text-destructive",
            )}
          >
            {isUp ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : isDown ? (
              <ArrowDownRight className="h-3 w-3" />
            ) : (
              <Minus className="h-3 w-3" />
            )}
            {pct !== undefined ? `${Math.abs(pct).toFixed(0)}%` : Math.abs(delta)}
          </span>
        )}
      </div>
      <div
        className={cn(
          "crm-card-value mt-2 tabular-nums",
          accent === "success" && "text-success",
          accent === "destructive" && "text-destructive",
        )}
      >
        {value.toLocaleString()}
      </div>
      {sub && <div className="crm-card-label mt-1">{sub}</div>}
    </div>
  );
}

function Leaderboard({
  rows,
  accent,
}: {
  rows: { label: string; sub?: string | null; value: number }[];
  accent: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="space-y-2">
      {rows.slice(0, 8).map((r, i) => (
        <li key={`${r.label}-${i}`} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-[12px]">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="w-4 text-muted-foreground tabular-nums text-[11px]">{i + 1}</span>
              <span className="font-medium tracking-tight truncate">{r.label}</span>
              {r.sub && (
                <span className="text-[10.5px] text-muted-foreground truncate">{r.sub}</span>
              )}
            </div>
            <span className="tabular-nums font-semibold">{r.value}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${(r.value / max) * 100}%`, background: accent }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="text-[12px] text-muted-foreground py-6 text-center">{label}</div>;
}

function Card({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("crm-surface-card p-5", className)}>
      <div className="mb-4">
        <h3 className="crm-section-title">{title}</h3>
        {subtitle && <p className="crm-card-label mt-1">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

type SentToCsGranularity = "daily" | "cumulative" | "day_of_week";
type SentToCsChartType = "area" | "bar";

function SentToCsSection({
  series,
  prevSeries,
  since,
  until,
}: {
  series: DailyRow[];
  prevSeries: DailyRow[];
  since: string;
  until: string;
}) {
  const [granularity, setGranularity] = useState<SentToCsGranularity>("daily");
  const [chartType, setChartType] = useState<SentToCsChartType>("area");
  const [selectedDept, setSelectedDept] = useState<DeptKey | "all">("all");

  // Fetch department breakdown for leads sent to CS in this date range
  const deptLeadsQuery = useQuery({
    queryKey: ["sent-to-cs-dept-breakdown", since, until],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qualified_leads")
        .select("assigned_at, submitted_by_role")
        .gte("assigned_at", since)
        .lt("assigned_at", until);
      if (error) {
        console.warn("Could not fetch sent-to-cs dept breakdown:", error);
        return [];
      }
      return (data ?? []) as Array<{
        assigned_at: string | null;
        submitted_by_role: string | null;
      }>;
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  const deptRows = useMemo(() => deptLeadsQuery.data ?? [], [deptLeadsQuery.data]);

  // Totals by department for pills
  const deptCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: 0,
      maturing: 0,
      sub_admin: 0,
      seo: 0,
      facebook: 0,
    };
    for (const r of deptRows) {
      counts.all += 1;
      const role = r.submitted_by_role as DeptKey;
      if (role && role in counts) {
        counts[role] += 1;
      }
    }
    return counts;
  }, [deptRows]);

  // Compute active daily series based on selected department
  const filteredDailySeries = useMemo(() => {
    if (selectedDept === "all") {
      return series.map((d) => ({
        day: d.day,
        key: d.key,
        count: d.sentToCS,
      }));
    }

    // Filter by department
    const map = new Map<string, number>();
    for (const r of deptRows) {
      if (r.submitted_by_role === selectedDept && r.assigned_at) {
        const dayKey = r.assigned_at.slice(0, 10);
        map.set(dayKey, (map.get(dayKey) ?? 0) + 1);
      }
    }

    return series.map((d) => ({
      day: d.day,
      key: d.key,
      count: map.get(d.key) ?? 0,
    }));
  }, [selectedDept, series, deptRows]);

  // Compute metrics
  const totalCount = useMemo(
    () => filteredDailySeries.reduce((acc, d) => acc + d.count, 0),
    [filteredDailySeries],
  );

  const prevTotalCount = useMemo(
    () => prevSeries.reduce((acc, d) => acc + d.sentToCS, 0),
    [prevSeries],
  );

  const daysCount = Math.max(1, filteredDailySeries.length);
  const dailyAvg = Math.round((totalCount / daysCount) * 10) / 10;

  const peakDay = useMemo(() => {
    if (filteredDailySeries.length === 0) return { day: "—", count: 0 };
    return filteredDailySeries.reduce(
      (max, d) => (d.count > max.count ? d : max),
      filteredDailySeries[0],
    );
  }, [filteredDailySeries]);

  const pctChange =
    prevTotalCount > 0
      ? Math.round(((totalCount - prevTotalCount) / prevTotalCount) * 1000) / 10
      : null;

  // Compute cumulative series
  const cumulativeSeries = useMemo(() => {
    let running = 0;
    return filteredDailySeries.map((d) => {
      running += d.count;
      return {
        day: d.day,
        key: d.key,
        count: running,
      };
    });
  }, [filteredDailySeries]);

  // Compute day of week series (Mon - Sun)
  const dayOfWeekSeries = useMemo(() => {
    const daysName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const buckets: Record<string, { total: number; occurrences: number }> = {};
    daysName.forEach((n) => {
      buckets[n] = { total: 0, occurrences: 0 };
    });

    for (const d of filteredDailySeries) {
      if (!d.key) continue;
      const dateObj = new Date(d.key + "T12:00:00");
      const name = daysName[dateObj.getDay()];
      if (buckets[name]) {
        buckets[name].total += d.count;
        buckets[name].occurrences += 1;
      }
    }

    const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return order.map((name) => {
      const b = buckets[name];
      const avg = b.occurrences > 0 ? Math.round((b.total / b.occurrences) * 10) / 10 : 0;
      return {
        day: name,
        count: b.total,
        avg,
      };
    });
  }, [filteredDailySeries]);

  // Selected chart data depending on granularity
  const chartData = useMemo(() => {
    if (granularity === "cumulative") return cumulativeSeries;
    if (granularity === "day_of_week") return dayOfWeekSeries;
    return filteredDailySeries;
  }, [granularity, cumulativeSeries, dayOfWeekSeries, filteredDailySeries]);

  const activeColor =
    selectedDept === "all"
      ? "var(--color-primary)"
      : (DEPARTMENTS.find((d) => d.key === selectedDept)?.color ?? "var(--color-primary)");

  return (
    <Card
      title="Sent to CS Pipeline"
      subtitle={`Track handoff volume and velocity to the CS pipeline over time (${totalCount.toLocaleString()} total)`}
    >
      {/* ─── Top KPI Metric Cards ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="p-3 rounded-lg border border-border/60 bg-muted/20">
          <div className="text-[11px] font-medium text-muted-foreground">Total Sent to CS</div>
          <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
            {totalCount.toLocaleString()}
          </div>
          {pctChange !== null && (
            <div className="mt-0.5 flex items-center text-[10.5px] gap-0.5">
              {pctChange >= 0 ? (
                <span className="text-emerald-500 font-medium flex items-center">
                  <ArrowUpRight className="h-3 w-3" />+{pctChange}%
                </span>
              ) : (
                <span className="text-destructive font-medium flex items-center">
                  <ArrowDownRight className="h-3 w-3" />
                  {pctChange}%
                </span>
              )}
              <span className="text-muted-foreground text-[10px]">vs prev</span>
            </div>
          )}
        </div>

        <div className="p-3 rounded-lg border border-border/60 bg-muted/20">
          <div className="text-[11px] font-medium text-muted-foreground">Daily Average</div>
          <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
            {dailyAvg.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[10.5px] text-muted-foreground">leads / day</div>
        </div>

        <div className="p-3 rounded-lg border border-border/60 bg-muted/20">
          <div className="text-[11px] font-medium text-muted-foreground">Peak Day</div>
          <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
            {peakDay.count.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[10.5px] text-muted-foreground truncate">{peakDay.day}</div>
        </div>

        <div className="p-3 rounded-lg border border-border/60 bg-muted/20">
          <div className="text-[11px] font-medium text-muted-foreground">Active Days</div>
          <div className="mt-1 text-xl font-bold tabular-nums text-foreground">{daysCount}</div>
          <div className="mt-0.5 text-[10.5px] text-muted-foreground">in selected range</div>
        </div>
      </div>

      {/* ─── Control Toolbar (Source + Granularity + Chart Style) ─── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-border/50">
        {/* Source / Department Filter */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground font-medium mr-1 flex items-center gap-1">
            <Filter className="h-3 w-3" /> Source:
          </span>
          <button
            type="button"
            onClick={() => setSelectedDept("all")}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer",
              selectedDept === "all"
                ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                : "bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            All Sources
            {deptCounts.all > 0 && (
              <span className="ml-1.5 opacity-80 text-[10px] tabular-nums">({deptCounts.all})</span>
            )}
          </button>
          {DEPARTMENTS.map((dept) => {
            const isSelected = selectedDept === dept.key;
            const count = deptCounts[dept.key] ?? 0;
            return (
              <button
                key={dept.key}
                type="button"
                onClick={() => setSelectedDept(dept.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer",
                  isSelected
                    ? "shadow-xs font-semibold text-foreground ring-1"
                    : "bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground",
                )}
                style={
                  isSelected
                    ? {
                        backgroundColor: `${dept.color}25`,
                        borderColor: dept.color,
                      }
                    : undefined
                }
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: dept.color }}
                />
                <span>{dept.label}</span>
                {count > 0 && (
                  <span className="opacity-80 text-[10px] tabular-nums">({count})</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Time Granularity & Chart Type Toggles */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Granularity */}
          <div className="flex items-center rounded-lg bg-muted/60 p-0.5 border border-border/50 text-xs">
            {(
              [
                ["daily", "Daily"],
                ["cumulative", "Cumulative"],
                ["day_of_week", "Day of Week"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setGranularity(key)}
                className={cn(
                  "px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer",
                  granularity === key
                    ? "bg-card text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Chart Style (Area vs Bar) */}
          <div className="flex items-center rounded-lg bg-muted/60 p-0.5 border border-border/50 text-xs">
            <button
              type="button"
              onClick={() => setChartType("area")}
              className={cn(
                "px-2 py-1 rounded-md font-medium transition-colors cursor-pointer",
                chartType === "area"
                  ? "bg-card text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Area Chart"
            >
              Area
            </button>
            <button
              type="button"
              onClick={() => setChartType("bar")}
              className={cn(
                "px-2 py-1 rounded-md font-medium transition-colors cursor-pointer",
                chartType === "bar"
                  ? "bg-card text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Bar Chart"
            >
              Bar
            </button>
          </div>
        </div>
      </div>

      {/* ─── Main Chart ─── */}
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === "area" ? (
            <AreaChart data={chartData} margin={{ top: 15, right: 15, left: -20, bottom: 5 }}>
              <defs>
                <linearGradient id="sentToCsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={activeColor} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={activeColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval={
                  granularity === "day_of_week" ? 0 : Math.max(0, Math.floor(chartData.length / 8))
                }
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(val: unknown) => [
                  `${Number(val).toLocaleString()} leads`,
                  granularity === "cumulative"
                    ? "Cumulative to CS"
                    : granularity === "day_of_week"
                      ? "Total on this day"
                      : "Sent to CS",
                ]}
              />
              {granularity === "daily" && dailyAvg > 0 && (
                <ReferenceLine
                  y={dailyAvg}
                  stroke="var(--color-muted-foreground)"
                  strokeDasharray="4 4"
                  strokeOpacity={0.7}
                  label={{
                    value: `Avg ${dailyAvg}`,
                    position: "top",
                    fill: "var(--color-muted-foreground)",
                    fontSize: 10,
                  }}
                />
              )}
              <Area
                type="monotone"
                dataKey="count"
                stroke={activeColor}
                strokeWidth={2.5}
                fill="url(#sentToCsGradient)"
              />
            </AreaChart>
          ) : (
            <BarChart data={chartData} margin={{ top: 15, right: 15, left: -20, bottom: 5 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval={
                  granularity === "day_of_week" ? 0 : Math.max(0, Math.floor(chartData.length / 8))
                }
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(val: unknown) => [
                  `${Number(val).toLocaleString()} leads`,
                  granularity === "cumulative"
                    ? "Cumulative to CS"
                    : granularity === "day_of_week"
                      ? "Total on this day"
                      : "Sent to CS",
                ]}
              />
              {granularity === "daily" && dailyAvg > 0 && (
                <ReferenceLine
                  y={dailyAvg}
                  stroke="var(--color-muted-foreground)"
                  strokeDasharray="4 4"
                  strokeOpacity={0.7}
                  label={{
                    value: `Avg ${dailyAvg}`,
                    position: "top",
                    fill: "var(--color-muted-foreground)",
                    fontSize: 10,
                  }}
                />
              )}
              <Bar dataKey="count" fill={activeColor} radius={[4, 4, 0, 0]} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

type BreakdownMode = "service" | "state" | "service_by_state";

function formatStateLabel(
  stateCode: string | null | undefined,
  mainArea: string | null | undefined,
): string {
  if (stateCode && stateCode.trim()) {
    const code = stateCode.trim().toUpperCase();
    return US_STATE_NAME[code] ? `${US_STATE_NAME[code]} (${code})` : code;
  }
  if (mainArea && mainArea.trim()) {
    const area = mainArea.trim();
    const match = area.match(/\b([A-Z]{2})\b/);
    if (match && US_STATE_NAME[match[1]]) {
      return `${US_STATE_NAME[match[1]]} (${match[1]})`;
    }
    for (const [code, name] of Object.entries(US_STATE_NAME)) {
      if (area.toLowerCase() === name.toLowerCase()) {
        return `${name} (${code})`;
      }
    }
    return area;
  }
  return "(Not Specified)";
}

function DeptLeadsChart({ since, until }: { since: string; until: string }) {
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("service");
  const [selectedDept, setSelectedDept] = useState<DeptKey | "all">("all");
  const [selectedState, setSelectedState] = useState<string>("all");
  const [selectedService, setSelectedService] = useState<string>("all");
  const [stateSearch, setStateSearch] = useState<string>("");

  const deptQuery = useQuery({
    queryKey: ["analytics-dept-leads-raw", since, until],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qualified_leads")
        .select("service, state_code, main_area, submitted_by_role")
        .gte("assigned_at", since)
        .lt("assigned_at", until);

      if (error) {
        console.warn("Could not fetch department leads:", error);
        return [];
      }
      return (data ?? []) as Array<{
        service: string | null;
        state_code: string | null;
        main_area: string | null;
        submitted_by_role: string | null;
      }>;
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  const rawRows = useMemo(() => deptQuery.data ?? [], [deptQuery.data]);

  // Calculate department totals for pills
  const deptTotals = useMemo(() => {
    const counts: Record<string, number> = {
      all: 0,
      maturing: 0,
      sub_admin: 0,
      seo: 0,
      facebook: 0,
    };
    for (const r of rawRows) {
      counts.all += 1;
      const role = r.submitted_by_role as DeptKey;
      if (role && role in counts) {
        counts[role] += 1;
      }
    }
    return counts;
  }, [rawRows]);

  const activeDeptConfig = DEPARTMENTS.find((d) => d.key === selectedDept);
  const activeColor = activeDeptConfig?.color ?? "var(--color-primary)";
  const activeLabel = activeDeptConfig?.label ?? "All Departments";

  // Filter rows based on selected department
  const deptFilteredRows = useMemo(() => {
    if (selectedDept === "all") return rawRows;
    return rawRows.filter((r) => r.submitted_by_role === selectedDept);
  }, [rawRows, selectedDept]);

  // List of all states in this department (for state filter)
  const availableStates = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of deptFilteredRows) {
      const state = formatStateLabel(r.state_code, r.main_area);
      counts[state] = (counts[state] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count);
  }, [deptFilteredRows]);

  // List of all services in this department (for service filter)
  const availableServices = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of deptFilteredRows) {
      const s = r.service?.trim() || "(no service)";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => b.count - a.count);
  }, [deptFilteredRows]);

  // Filter rows based on active State / Service filter
  const activeFilteredRows = useMemo(() => {
    let rows = deptFilteredRows;
    if (
      (breakdownMode === "service" || breakdownMode === "service_by_state") &&
      selectedState !== "all"
    ) {
      rows = rows.filter((r) => formatStateLabel(r.state_code, r.main_area) === selectedState);
    } else if (breakdownMode === "state" && selectedService !== "all") {
      rows = rows.filter((r) => (r.service?.trim() || "(no service)") === selectedService);
    }
    return rows;
  }, [deptFilteredRows, breakdownMode, selectedState, selectedService]);

  const currentTotal = activeFilteredRows.length;

  // Compute breakdown data for the horizontal bar chart
  const breakdownData = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const r of activeFilteredRows) {
      const key =
        breakdownMode === "service"
          ? r.service?.trim() || "(no service)"
          : formatStateLabel(r.state_code, r.main_area);
      counts[key] = (counts[key] ?? 0) + 1;
    }

    return Object.entries(counts)
      .map(([name, count]) => ({
        name,
        count,
        pct: currentTotal > 0 ? (count / currentTotal) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 18);
  }, [activeFilteredRows, breakdownMode, currentTotal]);

  // Compute full "Service by State" matrix (In each state, how much each service has leads)
  const stateServiceMatrix = useMemo(() => {
    const map = new Map<string, { total: number; services: Record<string, number> }>();
    for (const r of deptFilteredRows) {
      const state = formatStateLabel(r.state_code, r.main_area);
      const service = r.service?.trim() || "(no service)";
      let entry = map.get(state);
      if (!entry) {
        entry = { total: 0, services: {} };
        map.set(state, entry);
      }
      entry.total += 1;
      entry.services[service] = (entry.services[service] ?? 0) + 1;
    }

    return Array.from(map.entries())
      .map(([state, data]) => {
        const sortedServices = Object.entries(data.services)
          .map(([service, count]) => ({
            service,
            count,
            pct: data.total > 0 ? (count / data.total) * 100 : 0,
          }))
          .sort((a, b) => b.count - a.count);
        return {
          state,
          total: data.total,
          pctOfDept: deptFilteredRows.length > 0 ? (data.total / deptFilteredRows.length) * 100 : 0,
          services: sortedServices,
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [deptFilteredRows]);

  // Filtered matrix based on stateSearch and selectedState
  const filteredMatrix = useMemo(() => {
    let list = stateServiceMatrix;
    if (selectedState !== "all") {
      list = list.filter((s) => s.state === selectedState);
    }
    if (stateSearch.trim()) {
      const q = stateSearch.toLowerCase().trim();
      list = list.filter((s) => s.state.toLowerCase().includes(q));
    }
    return list;
  }, [stateServiceMatrix, selectedState, stateSearch]);

  // Compute title & subtitle
  const chartTitle = useMemo(() => {
    if (breakdownMode === "service_by_state") {
      return "Department leads: Services by state";
    }
    if (breakdownMode === "service") {
      return selectedState !== "all"
        ? `Department leads by service — ${selectedState}`
        : "Department leads by service";
    }
    return selectedService !== "all"
      ? `Department leads by state — ${selectedService}`
      : "Department leads by state";
  }, [breakdownMode, selectedState, selectedService]);

  const chartSubtitle = useMemo(() => {
    if (breakdownMode === "service_by_state") {
      return `Showing lead counts for each service across all states for ${activeLabel} (${deptFilteredRows.length.toLocaleString()} leads across ${stateServiceMatrix.length} states)`;
    }
    if (breakdownMode === "service") {
      if (selectedState !== "all") {
        return `Showing services in ${selectedState} for ${activeLabel} (${currentTotal.toLocaleString()} lead${currentTotal === 1 ? "" : "s"} across ${breakdownData.length} service${breakdownData.length === 1 ? "" : "s"})`;
      }
      return `Showing services for ${activeLabel} (${currentTotal.toLocaleString()} lead${currentTotal === 1 ? "" : "s"} across ${breakdownData.length} service${breakdownData.length === 1 ? "" : "s"})`;
    }
    if (selectedService !== "all") {
      return `Showing states with ${selectedService} leads for ${activeLabel} (${currentTotal.toLocaleString()} lead${currentTotal === 1 ? "" : "s"} across ${breakdownData.length} state${breakdownData.length === 1 ? "" : "s"})`;
    }
    return `Showing states for ${activeLabel} (${currentTotal.toLocaleString()} lead${currentTotal === 1 ? "" : "s"} across ${breakdownData.length} state${breakdownData.length === 1 ? "" : "s"})`;
  }, [
    breakdownMode,
    selectedState,
    selectedService,
    activeLabel,
    currentTotal,
    breakdownData.length,
    deptFilteredRows.length,
    stateServiceMatrix.length,
  ]);

  return (
    <Card title={chartTitle} subtitle={chartSubtitle}>
      {/* ─── Control Bar: Department Pills + Mode Switcher ─── */}
      <div className="mb-4 space-y-3 border-b border-border/50 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Department Filter Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setSelectedDept("all");
              }}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer",
                selectedDept === "all"
                  ? "bg-primary text-primary-foreground shadow-xs font-semibold ring-2 ring-primary/30"
                  : "bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              <span>All Departments</span>
              <span
                className={cn(
                  "px-1.5 py-0.2 rounded-full text-[10px] tabular-nums",
                  selectedDept === "all"
                    ? "bg-primary-foreground/20 text-primary-foreground font-bold"
                    : "bg-background/80 text-muted-foreground",
                )}
              >
                {deptTotals.all}
              </span>
            </button>

            {DEPARTMENTS.map((dept) => {
              const count = deptTotals[dept.key] ?? 0;
              const isSelected = selectedDept === dept.key;
              return (
                <button
                  key={dept.key}
                  type="button"
                  onClick={() => {
                    setSelectedDept(dept.key);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer",
                    isSelected
                      ? "shadow-xs font-semibold ring-2 text-foreground"
                      : "bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground",
                  )}
                  style={
                    isSelected
                      ? {
                          backgroundColor: `${dept.color}25`,
                          borderColor: dept.color,
                          borderWidth: 1,
                          borderStyle: "solid",
                        }
                      : undefined
                  }
                >
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: dept.color }}
                  />
                  <span>{dept.label}</span>
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded-full text-[10px] tabular-nums",
                      isSelected
                        ? "font-bold text-foreground"
                        : "bg-background/80 text-muted-foreground",
                    )}
                    style={isSelected ? { backgroundColor: `${dept.color}35` } : undefined}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Breakdown Mode Switcher (By Service / By State / Service by State) */}
          <div className="flex items-center rounded-lg bg-muted/60 p-0.5 border border-border/50 text-xs shrink-0">
            <button
              type="button"
              onClick={() => setBreakdownMode("service")}
              className={cn(
                "px-3 py-1.5 rounded-md font-medium transition-all cursor-pointer flex items-center gap-1.5",
                breakdownMode === "service"
                  ? "bg-card text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>By Service</span>
            </button>
            <button
              type="button"
              onClick={() => setBreakdownMode("state")}
              className={cn(
                "px-3 py-1.5 rounded-md font-medium transition-all cursor-pointer flex items-center gap-1.5",
                breakdownMode === "state"
                  ? "bg-card text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <MapPin className="h-3.5 w-3.5" />
              <span>By State</span>
            </button>
            <button
              type="button"
              onClick={() => setBreakdownMode("service_by_state")}
              className={cn(
                "px-3 py-1.5 rounded-md font-medium transition-all cursor-pointer flex items-center gap-1.5",
                breakdownMode === "service_by_state"
                  ? "bg-card text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="See how many leads each service has in each state"
            >
              <Filter className="h-3.5 w-3.5" />
              <span>Services by State</span>
            </button>
          </div>
        </div>

        {/* Secondary Filter Bar: State / Service Drill-Down */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs">
          {/* State Filter when in By Service or Service by State */}
          {(breakdownMode === "service" || breakdownMode === "service_by_state") && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground font-medium flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-primary" /> Filter by State:
              </span>
              <div className="relative inline-flex items-center">
                <select
                  value={selectedState}
                  onChange={(e) => setSelectedState(e.target.value)}
                  className="h-8 rounded-md bg-muted/60 border border-border/70 px-2.5 pr-8 py-1 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                >
                  <option value="all">All States ({deptFilteredRows.length} leads)</option>
                  {availableStates.map((st) => (
                    <option key={st.state} value={st.state}>
                      {st.state} ({st.count} lead{st.count === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
              </div>

              {selectedState !== "all" && (
                <button
                  type="button"
                  onClick={() => setSelectedState("all")}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium cursor-pointer"
                  title="Clear state filter"
                >
                  <span>{selectedState}</span>
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {/* Service Filter when in By State */}
          {breakdownMode === "state" && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground font-medium flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-primary" /> Filter by Service:
              </span>
              <div className="relative inline-flex items-center">
                <select
                  value={selectedService}
                  onChange={(e) => setSelectedService(e.target.value)}
                  className="h-8 rounded-md bg-muted/60 border border-border/70 px-2.5 pr-8 py-1 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                >
                  <option value="all">All Services ({deptFilteredRows.length} leads)</option>
                  {availableServices.map((s) => (
                    <option key={s.service} value={s.service}>
                      {s.service} ({s.count} lead{s.count === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
              </div>

              {selectedService !== "all" && (
                <button
                  type="button"
                  onClick={() => setSelectedService("all")}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium cursor-pointer"
                  title="Clear service filter"
                >
                  <span>{selectedService}</span>
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {/* Search box when in Service by State mode */}
          {breakdownMode === "service_by_state" && (
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search state..."
                value={stateSearch}
                onChange={(e) => setStateSearch(e.target.value)}
                className="pl-8 h-8 text-xs bg-muted/40"
              />
              {stateSearch && (
                <button
                  type="button"
                  onClick={() => setStateSearch("")}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {deptQuery.isLoading ? (
        <div className="h-64 flex items-center justify-center text-muted-foreground text-xs gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span>Loading department data...</span>
        </div>
      ) : breakdownMode === "service_by_state" ? (
        /* ─── Service by State: In each state how much each service has leads ─── */
        filteredMatrix.length === 0 ? (
          <EmptyState label="No state data found matching your selection" />
        ) : (
          <div className="space-y-4">
            {/* Quick State Pills Bar */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-2 scrollbar-thin">
              <button
                type="button"
                onClick={() => setSelectedState("all")}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium shrink-0 transition-colors cursor-pointer",
                  selectedState === "all"
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "bg-muted/60 text-muted-foreground hover:text-foreground",
                )}
              >
                All States ({deptFilteredRows.length})
              </button>
              {availableStates.slice(0, 10).map((st) => (
                <button
                  key={st.state}
                  type="button"
                  onClick={() => setSelectedState(st.state === selectedState ? "all" : st.state)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-xs font-medium shrink-0 transition-colors cursor-pointer inline-flex items-center gap-1",
                    selectedState === st.state
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "bg-muted/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{st.state}</span>
                  <span className="opacity-75 text-[10.5px]">({st.count})</span>
                </button>
              ))}
            </div>

            {/* Grid of State Cards with Services Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
              {filteredMatrix.map((item) => (
                <div
                  key={item.state}
                  className="rounded-lg border border-border/70 bg-card p-4 hover:border-primary/50 transition-all flex flex-col justify-between"
                >
                  <div>
                    {/* State Card Header */}
                    <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-2.5 mb-3">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="font-semibold text-sm text-foreground truncate">
                          {item.state}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-primary/15 text-primary tabular-nums">
                          {item.total.toLocaleString()} leads
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedState(item.state);
                            setBreakdownMode("service");
                          }}
                          className="text-[11px] text-muted-foreground hover:text-primary transition-colors cursor-pointer font-medium underline"
                          title="View in horizontal bar chart"
                        >
                          Chart
                        </button>
                      </div>
                    </div>

                    {/* Services Breakdown in this State */}
                    <div className="space-y-2">
                      {item.services.slice(0, 6).map((svc) => (
                        <div key={svc.service} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span
                              className="truncate text-muted-foreground font-medium max-w-[200px]"
                              title={svc.service}
                            >
                              {svc.service}
                            </span>
                            <span className="tabular-nums font-semibold text-foreground text-[11.5px]">
                              {svc.count}{" "}
                              <span className="text-[10px] text-muted-foreground font-normal">
                                ({svc.pct.toFixed(1)}%)
                              </span>
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${Math.max(2, svc.pct)}%`,
                                backgroundColor: activeColor,
                              }}
                            />
                          </div>
                        </div>
                      ))}

                      {item.services.length > 6 && (
                        <div className="pt-1.5 text-[11px] text-muted-foreground text-center">
                          +{item.services.length - 6} more service
                          {item.services.length - 6 === 1 ? "" : "s"} (
                          {item.services.slice(6).reduce((s, x) => s + x.count, 0)} leads)
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : breakdownData.length === 0 ? (
        <EmptyState
          label={`No ${breakdownMode === "service" ? "service" : "state"} leads recorded for ${activeLabel} in this date range`}
        />
      ) : (
        /* HORIZONTAL BAR CHART - Full names on the left, data labels on the right */
        <div className="w-full" style={{ height: Math.max(280, breakdownData.length * 42 + 40) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={breakdownData}
              margin={{ top: 10, right: 85, left: 10, bottom: 10 }}
            >
              <CartesianGrid
                stroke="var(--color-border)"
                strokeDasharray="3 3"
                horizontal={false}
              />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={170}
                tick={{ fontSize: 12, fill: "var(--color-foreground)", fontWeight: 500 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: unknown) => [
                  `${Number(value).toLocaleString()} leads (${currentTotal ? ((Number(value) / currentTotal) * 100).toFixed(1) : 0}%)`,
                  activeLabel,
                ]}
              />
              <Bar
                dataKey="count"
                name={activeLabel}
                fill={activeColor}
                radius={[0, 6, 6, 0]}
                barSize={20}
                className={breakdownMode === "state" ? "cursor-pointer" : undefined}
                onClick={(entry: { name?: string }) => {
                  if (breakdownMode === "state" && entry?.name) {
                    setSelectedState(entry.name);
                    setBreakdownMode("service");
                  }
                }}
              >
                <LabelList
                  dataKey="count"
                  position="right"
                  formatter={(val: unknown) => `${val} leads`}
                  style={{ fontSize: 11, fill: "var(--color-muted-foreground)", fontWeight: 500 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
