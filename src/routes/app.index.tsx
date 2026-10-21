import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { startOfDay } from "date-fns";
import {
  ArrowUpRight,
  Inbox,
  CheckCircle2,
  Send,
  Trophy,
  Clock,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody } from "@/components/page";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Lead Overview \u00b7 JellyBean" },
      { name: "description", content: "Review lead outcomes and daily operations in JellyBean." },
      { property: "og:title", content: "Lead Overview \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Review lead outcomes and daily operations in JellyBean.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DashboardHome,
});

const CS_STATUSES = [
  "new",
  "undeliver",
  "wrong_number",
  "wrong_lead",
  "already_got_someone",
  "service_provider_himself",
  "small_service",
  "converted",
  "cx_interested",
  "cx_not_interested",
  "cx_didnt_replied",
  "need_follow_up",
] as const;

const CS_LABELS: Record<string, string> = {
  new: "New to contact",
  undeliver: "Undeliver",
  wrong_number: "Wrong number",
  wrong_lead: "Wrong lead",
  already_got_someone: "Already got someone",
  service_provider_himself: "Service provider himself",
  small_service: "Small service",
  converted: "Delivered",
  cx_interested: "CX interested",
  cx_not_interested: "CX not interested",
  cx_didnt_replied: "CX didn't replied",
  need_follow_up: "Need follow-up",
};

function DashboardHome() {
  const auth = useAuth();
  const navigate = useNavigate();
  const role = auth.primaryRole;

  // Role-based landing redirect
  useEffect(() => {
    if (auth.loading) return;
    if (role === "cs" || role === "cs_admin") navigate({ to: "/app/cs-leads", replace: true });
    else if (role === "scraping" || role === "maturing")
      navigate({ to: "/app/raw-leads", replace: true });
    else if (role === "acc_handler") navigate({ to: "/app/map", replace: true });
    else if (role === "facebook" || role === "seo")
      navigate({ to: "/app/submit-lead", replace: true });
  }, [auth.loading, role, navigate]);

  if (role !== "admin" && role !== "sub_admin") {
    return (
      <div className="min-h-[60vh] grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <AdminDashboard />;
}

function AdminDashboard() {
  const auth = useAuth();
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();
  const firstName = auth.profile?.full_name?.split(" ")[0];

  const stats = useQuery({
    queryKey: ["admin-dashboard-stats"],
    queryFn: async () => {
      const today = startOfDay(new Date()).toISOString();
      const { data, error } = await supabase.rpc("get_admin_dashboard_stats", {
        _today: today,
      });
      if (error) throw error;

      // Cast the csCounts values from the database returned object
      const csCounts: Record<string, number> = {};
      CS_STATUSES.forEach((status) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        csCounts[status] = Number((data as any)?.csCounts?.[status] ?? 0);
      });

      return {
        rawCounts: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          new: Number((data as any)?.rawCounts?.new ?? 0),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          forwarded: Number((data as any)?.rawCounts?.forwarded ?? 0),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          notFound: Number((data as any)?.rawCounts?.notFound ?? 0),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wrong: Number((data as any)?.rawCounts?.wrong ?? 0),
        },
        csCounts,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        todayRaw: Number((data as any)?.todayRaw ?? 0),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        todayForwarded: Number((data as any)?.todayForwarded ?? 0),
      };
    },
  });

  const tiles = [
    {
      label: "New raw leads",
      value: stats.data?.rawCounts.new ?? 0,
      icon: Inbox,
      to: "/app/raw-leads",
    },
    {
      label: "Forwarded to CS",
      value: stats.data?.rawCounts.forwarded ?? 0,
      icon: Send,
      to: "/app/raw-leads",
    },
    {
      label: "Number not found",
      value: stats.data?.rawCounts.notFound ?? 0,
      icon: AlertCircle,
      to: "/app/raw-leads",
    },
    {
      label: "Wrong posts",
      value: stats.data?.rawCounts.wrong ?? 0,
      icon: AlertCircle,
      to: "/app/raw-leads",
    },
    {
      label: "Delivered",
      value: stats.data?.csCounts.converted ?? 0,
      icon: Trophy,
      to: "/app/cs-leads",
    },
    {
      label: "Follow-ups",
      value: stats.data?.csCounts.need_follow_up ?? 0,
      icon: Clock,
      to: "/app/cs-leads",
    },
    {
      label: "New to contact",
      value: stats.data?.csCounts.new ?? 0,
      icon: CheckCircle2,
      to: "/app/cs-leads",
    },
  ];

  return (
    <div>
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ""}`}
        description={`Live operational overview for ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.`}
      />
      <PageBody className="space-y-6">
        <div className="crm-section-panel">
          {stats.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/35 bg-destructive/5 p-4 text-sm">
              <div>
                <div className="font-semibold text-destructive">
                  Dashboard data could not be loaded
                </div>
                <p className="mt-1 text-muted-foreground">
                  Your lead counts have not been updated. Try again before acting on them.
                </p>
              </div>
              <Button variant="outline" onClick={() => stats.refetch()} disabled={stats.isFetching}>
                {stats.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Retry
              </Button>
            </div>
          ) : stats.isLoading ? (
            <div
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-7"
              aria-busy="true"
              aria-label="Loading dashboard metrics"
            >
              {Array.from({ length: 7 }).map((_, index) => (
                <div key={index} className="rounded-2xl border border-border bg-card p-5">
                  <Skeleton className="h-11 w-11 rounded-2xl" />
                  <Skeleton className="mt-7 h-8 w-16" />
                  <Skeleton className="mt-3 h-4 w-28" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 gap-4">
              {tiles.map((t) => (
                <Link
                  key={t.label}
                  to={t.to}
                  className="bg-card border border-border shadow-sm rounded-2xl p-5 hover:shadow-md hover:border-primary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-all relative overflow-hidden"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="h-11 w-11 rounded-2xl grid place-items-center border border-border/50 bg-surface shadow-sm">
                      <t.icon className="h-4.5 w-4.5 text-primary" />
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="crm-card-value mt-7 tabular-nums">{t.value}</div>
                  <div className="crm-card-label mt-2">{t.label}</div>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="crm-section-panel">
            <div className="crm-surface-card crm-accent-sky p-6">
              <h3 className="crm-section-title mb-4">Today</h3>
              <div className="space-y-3 text-[13px] crm-muted-text">
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/78 px-4 py-3 shadow-sm">
                  <span>New raw leads captured</span>
                  <span className="text-base font-semibold text-foreground tabular-nums">
                    {stats.isLoading ? (
                      <Skeleton className="h-5 w-10" />
                    ) : (
                      (stats.data?.todayRaw ?? "—")
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/78 px-4 py-3 shadow-sm">
                  <span>Leads forwarded to CS</span>
                  <span className="text-base font-semibold text-foreground tabular-nums">
                    {stats.isLoading ? (
                      <Skeleton className="h-5 w-10" />
                    ) : (
                      (stats.data?.todayForwarded ?? "—")
                    )}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="crm-section-panel">
            <div className="crm-surface-card crm-accent-navy p-6">
              <h3 className="crm-section-title mb-4">CS pipeline mix</h3>
              <div className="text-[13px] crm-muted-text space-y-2">
                {stats.isLoading ? (
                  <div className="space-y-2" aria-busy="true">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <Skeleton key={index} className="h-11 w-full rounded-2xl" />
                    ))}
                  </div>
                ) : (
                  Object.entries(stats.data?.csCounts ?? {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 6)
                    .map(([k, v]) => (
                      <div
                        key={k}
                        className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/80 px-4 py-3 shadow-sm"
                      >
                        <span>{CS_LABELS[k] ?? k.replace(/_/g, " ")}</span>
                        <span className="font-semibold text-foreground tabular-nums">{v}</span>
                      </div>
                    ))
                )}
                {stats.isSuccess && Object.keys(stats.data?.csCounts ?? {}).length === 0 && (
                  <div>No leads yet.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </PageBody>
    </div>
  );
}
