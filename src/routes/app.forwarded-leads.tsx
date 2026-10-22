import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { listCsTeam } from "@/lib/cs-team.functions";
import { isCsUser } from "@/lib/cs-filter";
import { RouteSkeleton } from "@/components/route-skeleton";
import { useMemo, useState, useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarRange,
  Edit3,
  Loader2,
  MapPin,
  Phone,
  MessageSquareText,
  RefreshCw,
  Search,
  Trash2,
  Lock,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  Bell,
} from "lucide-react";
import { formatDistanceToNow, startOfDay, endOfDay } from "date-fns";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";
import { useAuth } from "@/hooks/use-auth";
import { syncLeadToGoogleSheet } from "@/lib/google-sheets-sync";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { formatPhone, phoneSearchPattern, phoneDigitsMatch } from "@/lib/crm-lite";
import { LeadForm, type LeadFormValues, type LeadReferenceMode } from "@/components/lead-form";
import { uploadLeadImages } from "@/lib/lead-form-utils";
import type { ForwardedStatus } from "@/lib/crm-types";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/lead-statuses";
import { cn } from "@/lib/utils";
import { confirmDiscardUnsaved } from "@/components/confirm-dialog-store";
import { LeadReminderDialog, type ReminderLeadInfo } from "@/components/lead-reminder-dialog";

export const Route = createFileRoute("/app/forwarded-leads")({
  head: () => ({
    meta: [
      { title: "Forwarded Leads \u00b7 JellyBean" },
      { name: "description", content: "Track your forwarded leads and their customer outcomes." },
      { property: "og:title", content: "Forwarded Leads \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Track your forwarded leads and their customer outcomes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
});

type Row = {
  id: string;
  customer_name: string;
  customer_number: string;
  customer_number_2: string | null;
  service: string | null;
  context: string | null;
  pass_it_to: string | null;
  main_area: string | null;
  sub_area: string | null;
  original_lead_link: string | null;
  cs_status: ForwardedStatus | string;
  contact_method: string | null;
  assigned_at: string;
  assigned_by: string | null;
  updated_at: string;
  created_by: string | null;
  extra_numbers: string[];
  images: string[];
  post_text: string | null;
  reference: string | null;
  is_important: boolean;
  pinned_important: boolean;
  submitted_by_role: string | null;
  is_landline: boolean;
  assigned_to: string | null;
  out_of_base: boolean;
};

const OUTCOME_FILTERS = [
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
] as const;

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Forwarded Leads"
        description="Leads you forwarded to CS, and how CS resolved them."
      />
      <PageBody className="!pt-5">
        <RoleGate
          allow={["admin", "sub_admin", "maturing", "acc_handler", "facebook", "seo"]}
          current={auth.primaryRole}
        >
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const auth = useAuth();
  const qc = useQueryClient();
  const isAdmin = auth.primaryRole === "admin" || auth.primaryRole === "sub_admin";
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "pending" | ForwardedStatus>("all");
  const [forwardedByFilter, setForwardedByFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [reminderLead, setReminderLead] = useState<ReminderLeadInfo | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const dbSearch = useMemo(() => {
    // Strip characters that break postgrest .or() — including parentheses, which
    // it treats as grouping syntax (so a formatted phone like "(216) 533-1500"
    // would otherwise corrupt the filter and return nothing).
    return debouncedQuery.replace(/[(),"'%\\]/g, "");
  }, [debouncedQuery]);

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 200;

  const dbDateFrom = useMemo(() => {
    return dateFrom ? startOfDay(new Date(dateFrom)).toISOString() : null;
  }, [dateFrom]);

  const dbDateTo = useMemo(() => {
    return dateTo ? endOfDay(new Date(dateTo)).toISOString() : null;
  }, [dateTo]);

  useEffect(() => {
    setPage(1);
  }, [dbDateFrom, dbDateTo, forwardedByFilter, outcomeFilter, dbSearch]);

  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);

  const sentToday = useQuery({
    queryKey: ["forwarded-sent-today", auth.user?.id],
    enabled: !!auth.user?.id,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      let q = supabase
        .from("qualified_leads")
        .select("id", { count: "exact", head: true })
        .gte("assigned_at", todayStart);
      if (!isAdmin) q = q.eq("created_by", auth.user!.id);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });

  const notFoundCount = useQuery({
    queryKey: ["forwarded-not-found", auth.user?.id, isAdmin],
    enabled: !!auth.user?.id,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      let q = supabase
        .from("raw_lead_cache")
        .select("row_key", { count: isAdmin ? "planned" : "exact", head: true })
        .eq("category", "not_found");
      if (!isAdmin) q = q.eq("categorized_by", auth.user!.id);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });

  const allProfiles = useQuery({
    queryKey: ["all_profiles"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("user_id, full_name, email");

      if (error) throw error;
      return data ?? [];
    },
  });

  const profilesById = useMemo(() => {
    const map = new Map<string, { full_name: string | null; email: string }>();
    for (const p of allProfiles.data ?? []) {
      map.set(p.user_id, { full_name: p.full_name, email: p.email });
    }
    return map;
  }, [allProfiles.data]);

  const listTeamFn = useServerFn(listCsTeam);
  const csTeam = useQuery({
    queryKey: ["cs-team-forwarded"],
    enabled: !!auth.user?.id,
    queryFn: () => listTeamFn(),
    staleTime: 5 * 60_000,
  });
  const csById = useMemo(() => {
    const map = new Map<string, { full_name: string; email: string }>();
    for (const m of csTeam.data ?? []) {
      map.set(m.user_id, { full_name: m.full_name, email: m.email });
    }
    return map;
  }, [csTeam.data]);

  const csUserIds = useMemo(() => {
    return new Set((csTeam.data ?? []).map((m) => m.user_id));
  }, [csTeam.data]);

  const list = useQuery({
    queryKey: [
      "forwarded-leads",
      auth.user?.id,
      isAdmin,
      { page, dbDateFrom, dbDateTo, forwardedByFilter, outcomeFilter, dbSearch },
    ],
    enabled: !!auth.user?.id,
    queryFn: async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = supabase
        .from("qualified_leads")
        .select(
          "id, customer_name, customer_number, customer_number_2, extra_numbers, service, context, post_text, pass_it_to, main_area, sub_area, original_lead_link, reference, is_important, pinned_important, is_landline, images, submitted_by_role, cs_status, contact_method, assigned_at, assigned_by, assigned_to, updated_at, created_by, out_of_base",
        )
        .order("updated_at", { ascending: false })
        .range(from, to);

      if (dbDateFrom) q = q.gte("assigned_at", dbDateFrom);
      if (dbDateTo) q = q.lte("assigned_at", dbDateTo);

      if (outcomeFilter === "pending") {
        q = q.eq("cs_status", "new");
      } else if (outcomeFilter !== "all") {
        q = q.eq("cs_status", outcomeFilter);
      }

      if (forwardedByFilter !== "all") {
        q = q.or(`created_by.eq.${forwardedByFilter},assigned_by.eq.${forwardedByFilter}`);
      }

      if (dbSearch) {
        const s = `%${dbSearch}%`;
        // Separator-agnostic phone pattern so a digits-only query matches
        // formatted stored numbers (and vice versa).
        const phone = phoneSearchPattern(dbSearch) ?? s;
        q = q.or(
          `customer_name.ilike.${s},customer_number.ilike.${phone},service.ilike.${s},context.ilike.${s},pass_it_to.ilike.${s},main_area.ilike.${s},sub_area.ilike.${s}`,
        );
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
    placeholderData: keepPreviousData,
  });

  const totalCount = useQuery({
    queryKey: [
      "forwarded-leads-count",
      auth.user?.id,
      isAdmin,
      { dbDateFrom, dbDateTo, forwardedByFilter, outcomeFilter, dbSearch },
    ],
    enabled: !!auth.user?.id,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // Exact counting the whole table is expensive; fall back to the planner
      // estimate for the unfiltered view and keep exact counts for filters.
      const hasFilter = Boolean(
        dbDateFrom ||
        dbDateTo ||
        dbSearch ||
        outcomeFilter !== "all" ||
        forwardedByFilter !== "all",
      );
      let q = supabase
        .from("qualified_leads")
        .select("id", { count: hasFilter ? "exact" : "planned", head: true });

      if (dbDateFrom) q = q.gte("assigned_at", dbDateFrom);
      if (dbDateTo) q = q.lte("assigned_at", dbDateTo);

      if (outcomeFilter === "pending") {
        q = q.eq("cs_status", "new");
      } else if (outcomeFilter !== "all") {
        q = q.eq("cs_status", outcomeFilter);
      }

      if (forwardedByFilter !== "all") {
        q = q.or(`created_by.eq.${forwardedByFilter},assigned_by.eq.${forwardedByFilter}`);
      }

      if (dbSearch) {
        const s = `%${dbSearch}%`;
        // Separator-agnostic phone pattern so a digits-only query matches
        // formatted stored numbers (and vice versa).
        const phone = phoneSearchPattern(dbSearch) ?? s;
        q = q.or(
          `customer_name.ilike.${s},customer_number.ilike.${phone},service.ilike.${s},context.ilike.${s},pass_it_to.ilike.${s},main_area.ilike.${s},sub_area.ilike.${s}`,
        );
      }

      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    placeholderData: keepPreviousData,
  });

  const totalPages = Math.max(1, Math.ceil((totalCount.data ?? 0) / PAGE_SIZE));

  const filtered = useMemo(() => {
    const rows = list.data ?? [];
    const q = dbSearch.trim();
    // When the query is phone-like, tighten the DB's separator-agnostic match
    // (which matches digit subsequences) down to contiguous digit matches so
    // stray results don't show. Non-phone text queries are left to the DB.
    if (q.replace(/\D/g, "").length < 3) return rows;
    const lower = q.toLowerCase();
    return rows.filter((r) => {
      const textMatch = [
        r.customer_name,
        r.service,
        r.context,
        r.pass_it_to,
        r.main_area,
        r.sub_area,
      ].some((f) => f?.toLowerCase().includes(lower));
      return textMatch || phoneDigitsMatch(r.customer_number, q);
    });
  }, [list.data, dbSearch]);

  return (
    <div className="space-y-4">
      <div className="crm-section-panel">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat
            label="Sent to CS today"
            value={sentToday.data}
            sub={isAdmin ? "All users" : "By you"}
          />
          <Stat label="Total forwarded" value={totalCount.data} />
          <Stat
            label="Pending outcome"
            value={(list.data ?? []).filter((r) => r.cs_status === "new").length}
          />
          <Stat
            label="Number not found"
            value={notFoundCount.data}
            sub={isAdmin ? "All users" : "Checked by you"}
          />
        </div>
      </div>

      <div className="crm-toolbar-panel">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customer, area, phone..."
              className="w-full h-9 pl-9 pr-3 rounded-md bg-surface border border-border text-[13px] placeholder:text-muted-foreground/70 focus:outline-none"
            />
          </div>
          <Select
            value={outcomeFilter}
            onValueChange={(v) => setOutcomeFilter(v as typeof outcomeFilter)}
          >
            <SelectTrigger className="h-9 w-[180px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              {OUTCOME_FILTERS.map((status) => (
                <SelectItem key={status} value={status}>
                  {STATUS_LABEL[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Select value={forwardedByFilter} onValueChange={setForwardedByFilter}>
              <SelectTrigger className="h-9 w-[190px] text-[12px]">
                <SelectValue placeholder="Forwarded by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All forwarders</SelectItem>
                {(allProfiles.data ?? [])
                  .slice()
                  .filter((profile) => !isCsUser(profile, csUserIds))
                  .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email))
                  .map((profile) => (
                    <SelectItem key={profile.user_id} value={profile.user_id}>
                      {profile.full_name || profile.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
          <div className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2 h-9">
            <CalendarRange className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Forwarded from date"
              className="h-7 w-[132px] border-0 bg-transparent px-1 text-[12px] shadow-none"
            />
            <span className="text-[11px] text-muted-foreground">to</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              min={dateFrom || undefined}
              aria-label="Forwarded to date"
              className="h-7 w-[132px] border-0 bg-transparent px-1 text-[12px] shadow-none"
            />
          </div>
          {(dateFrom || dateTo || forwardedByFilter !== "all") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => {
                setDateFrom("");
                setDateTo("");
                setForwardedByFilter("all");
              }}
            >
              Clear filters
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-9 ml-auto"
            onClick={() => qc.invalidateQueries({ queryKey: ["forwarded-leads"] })}
            disabled={list.isFetching}
          >
            {list.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {list.error && (
        <div className="text-[12.5px] text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {(list.error as Error).message}
        </div>
      )}

      {list.isLoading && !list.data ? (
        <div className="crm-section-panel">
          <div className="glass-card p-16 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading...
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="crm-section-panel">
          <div className="glass-card p-10 text-center text-[12.5px] text-muted-foreground">
            <Search className="h-5 w-5 mx-auto mb-2 opacity-50" />
            No forwarded leads found for the current filter.
          </div>
        </div>
      ) : (
        <>
          <div className="crm-section-panel">
            <ForwardedTable
              rows={filtered}
              onEdit={setEditing}
              onRemind={setReminderLead}
              auth={auth}
              qc={qc}
              profilesById={profilesById}
              csById={csById}
              isAdmin={isAdmin}
            />
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-4">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => setPage(1)}
                disabled={page <= 1 || list.isFetching}
                title="First Page"
              >
                <ChevronsLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-[12px]"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || list.isFetching}
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
                disabled={page >= totalPages || list.isFetching}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages || list.isFetching}
                title="Last Page"
              >
                <ChevronsRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            void confirmDiscardUnsaved(isDirty).then((ok) => {
              if (ok) setEditing(null);
            });
          }
        }}
      >
        <DialogContent
          className="max-w-2xl max-h-[90vh] overflow-y-auto"
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogTitle className="sr-only">Edit Forwarded Lead</DialogTitle>
          {editing && (
            <UnifiedForwardedLeadForm
              lead={editing}
              onDirtyChange={setIsDirty}
              forwardedBy={(() => {
                const id = editing.created_by ?? editing.assigned_by;
                const profile = id ? profilesById.get(id) : null;
                return profile?.full_name || profile?.email || "Unknown user";
              })()}
              onCancel={() => {
                setEditing(null);
                setIsDirty(false);
              }}
              onSaved={() => {
                setEditing(null);
                setIsDirty(false);
                qc.invalidateQueries({ queryKey: ["forwarded-leads"] });
                qc.invalidateQueries({ queryKey: ["forwarded-sent-today"] });
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <LeadReminderDialog
        lead={reminderLead}
        open={!!reminderLead}
        onOpenChange={(o) => {
          if (!o) setReminderLead(null);
        }}
      />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value?: number | null; sub?: string }) {
  return (
    <div className="crm-surface-card p-5">
      <div className="crm-kicker">{label}</div>
      <div className="crm-card-value mt-1 tabular-nums">{value ?? "-"}</div>
      {sub && <div className="crm-card-label mt-1">{sub}</div>}
    </div>
  );
}

function ForwardedTable({
  rows,
  onEdit,
  onRemind,
  auth,
  qc,
  profilesById,
  csById,
  isAdmin,
}: {
  rows: Row[];
  onEdit: (row: Row) => void;
  onRemind: (info: ReminderLeadInfo) => void;
  auth: ReturnType<typeof useAuth>;
  qc: ReturnType<typeof useQueryClient>;
  profilesById: Map<string, { full_name: string | null; email: string }>;
  csById: Map<string, { full_name: string; email: string }>;
  isAdmin: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="crm-data-table">
        <thead className="bg-surface text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Customer</th>
            <th className="text-left px-3 py-2 font-medium">Phone</th>
            <th className="text-left px-3 py-2 font-medium">Area</th>
            <th className="text-left px-3 py-2 font-medium">Details</th>
            <th className="text-left px-3 py-2 font-medium">Post Link</th>
            <th className="text-left px-3 py-2 font-medium">Outcome</th>
            {isAdmin && <th className="text-left px-3 py-2 font-medium">Forwarded by</th>}
            <th className="text-left px-3 py-2 font-medium">Forwarded</th>
            <th className="text-left px-3 py-2 font-medium">Updated</th>
            <th className="text-right px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="crm-data-row border-t border-border">
              <td className="px-3 py-2 font-semibold text-foreground">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span>{r.customer_name}</span>
                  {r.out_of_base && (
                    <span className="inline-flex items-center rounded-full bg-[#fde8d5] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#b4530a] ring-1 ring-[#f4c79a]">
                      Out of Base
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5 flex-wrap">
                  <a
                    href={`tel:${r.customer_number}`}
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary"
                  >
                    <Phone className="h-3 w-3" /> {formatPhone(r.customer_number)}
                  </a>
                  {r.is_landline && (
                    <span className="inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-amber-500/30 dark:text-amber-300">
                      Landline
                    </span>
                  )}
                </span>
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {r.sub_area && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {r.sub_area}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-muted-foreground max-w-[260px]">
                <div className="truncate">
                  {[r.service, r.pass_it_to].filter(Boolean).join(" / ")}
                </div>
                {r.context && (
                  <div className="truncate text-[11.5px] crm-muted-text">{r.context}</div>
                )}
              </td>
              <td className="px-3 py-2">
                {r.original_lead_link ? (
                  <a
                    href={r.original_lead_link}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-primary hover:underline text-[12px] font-medium whitespace-nowrap"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    View Post
                  </a>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col items-start gap-1">
                  {r.cs_status === "new" ? (
                    <span className="text-[10.5px] px-2.5 py-1 rounded-full border font-medium bg-surface-hover text-foreground border-border shadow-sm">
                      Pending
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "text-[10.5px] px-2.5 py-1 rounded-full border font-medium shadow-sm",
                        STATUS_TONE[r.cs_status] ?? "bg-muted text-muted-foreground border-border",
                      )}
                    >
                      {STATUS_LABEL[r.cs_status] ?? r.cs_status.replace(/_/g, " ")}
                    </span>
                  )}
                  {r.cs_status !== "new" && (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium bg-surface/70 text-muted-foreground border-border/70"
                      title="How the customer was contacted"
                    >
                      {r.contact_method === "called" ? (
                        <Phone className="h-2.5 w-2.5" />
                      ) : (
                        <MessageSquareText className="h-2.5 w-2.5" />
                      )}
                      {r.contact_method === "called" ? "Called" : "Texted"}
                    </span>
                  )}
                </div>
              </td>
              {isAdmin && (
                <td className="px-3 py-2 text-muted-foreground">
                  {r.created_by || r.assigned_by
                    ? (profilesById.get(r.created_by ?? r.assigned_by!)?.full_name ??
                      profilesById.get(r.created_by ?? r.assigned_by!)?.email ??
                      "Unknown user")
                    : "-"}
                </td>
              )}
              <td className="px-3 py-2 text-muted-foreground tabular-nums">
                {formatDistanceToNow(new Date(r.assigned_at), { addSuffix: true })}
              </td>
              <td className="px-3 py-2 text-muted-foreground tabular-nums">
                {formatDistanceToNow(new Date(r.updated_at), { addSuffix: true })}
              </td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2"
                    onClick={() => {
                      const cs = r.assigned_to ? csById.get(r.assigned_to) : undefined;
                      onRemind({
                        id: r.id,
                        customer_name: r.customer_name,
                        customer_number: r.customer_number,
                        assignee_name: r.assigned_to
                          ? (cs?.full_name ?? r.pass_it_to ?? null)
                          : null,
                        is_unassigned: !r.assigned_to,
                      });
                    }}
                    disabled={r.cs_status === "converted"}
                    title={
                      r.cs_status === "converted"
                        ? "Delivered leads can't receive reminders"
                        : r.assigned_to
                          ? "Send reminder to assigned CS"
                          : "Send reminder to all CS users"
                    }
                  >
                    <Bell className="h-3.5 w-3.5" />
                  </Button>

                  {isAdmin || (r.cs_status === "new" && r.created_by === auth.user?.id) ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => onEdit(r)}
                        title="Edit lead"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 text-destructive hover:text-destructive"
                        onClick={() => void deleteForwardedLead(r, auth, qc)}
                        title="Delete lead"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/60 italic pr-2"
                      title="Only pending leads can be modified by staff"
                    >
                      <Lock className="h-3 w-3" /> Locked
                    </span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnifiedForwardedLeadForm({
  lead,
  forwardedBy,
  onDirtyChange,
  onCancel,
  onSaved,
}: {
  lead: Row;
  forwardedBy: string;
  onDirtyChange?: (isDirty: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const [saving, setSaving] = useState(false);
  const role = lead.submitted_by_role ?? auth.primaryRole ?? "maturing";
  const referenceMode: LeadReferenceMode =
    role === "facebook" ? "auto-fb" : role === "seo" ? "manual-text" : "manual-dropdown";

  async function save(values: LeadFormValues) {
    const isAdmin = auth.primaryRole === "admin" || auth.primaryRole === "sub_admin";
    if (!isAdmin && (lead.cs_status !== "new" || lead.created_by !== auth.user?.id)) {
      toast.error("You can only edit your own pending leads.");
      return;
    }
    setSaving(true);
    try {
      const uploadedImages =
        values.files.length > 0 && auth.user?.id
          ? await uploadLeadImages({ files: values.files, userId: auth.user.id, supabase })
          : [];
      const cleanedExtras = (values.extraNumbers ?? [])
        .map((number) => number.trim())
        .filter(Boolean)
        .map((number) => formatPhone(number) || number);
      const { error } = await supabase
        .from("qualified_leads")
        .update({
          customer_name: values.customerName,
          customer_number: formatPhone(values.customerNumber) || values.customerNumber,
          customer_number_2: cleanedExtras[0] ?? null,
          extra_numbers: cleanedExtras,
          service: values.service,
          pass_it_to: role === "facebook" || role === "seo" ? null : values.service,
          main_area: values.area || null,
          sub_area: values.area || null,
          context: values.context,
          post_text: values.exactCustomerText,
          reference: values.reference,
          is_important: lead.pinned_important ? true : values.isImportant,
          is_landline: values.isLandline,
          images: [...(values.existingImages ?? []), ...uploadedImages],
          original_lead_link:
            values.originalLeadLink !== undefined
              ? values.originalLeadLink
              : lead.original_lead_link,
        } as never)
        .eq("id", lead.id);
      if (error) throw error;
      void syncLeadToGoogleSheet("UPDATE", {
        ...lead,
        customer_name: values.customerName,
        customer_number: values.customerNumber,
        customer_number_2: cleanedExtras[0] ?? null,
        service: values.service,
        main_area: values.area || null,
        sub_area: values.area || null,
        context: values.context,
        requirement_1: values.exactCustomerText,
        is_important: lead.pinned_important ? true : values.isImportant,
      });
      toast.success("Forwarded lead updated");
      onSaved();
    } catch (error) {
      toast.error(friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <LeadForm
      title="Edit forwarded lead"
      submitLabel="Save changes"
      forwardedBy={forwardedBy}
      showAttachments
      areaRequired
      referenceMode={referenceMode}
      initialValues={{
        id: lead.id,
        customerName: lead.customer_name,
        customerNumber: lead.customer_number,
        extraNumbers: lead.extra_numbers ?? [],
        area: lead.main_area || lead.sub_area || "",
        service: lead.service || lead.pass_it_to || "",
        context: lead.context || "",
        exactCustomerText: lead.post_text || lead.context || "",
        reference: lead.reference || undefined,
        isImportant: lead.is_important,
        isLandline: (lead as { is_landline?: boolean }).is_landline ?? false,
        images: Array.isArray(lead.images) ? (lead.images as string[]) : [],
        originalLeadLink: lead.original_lead_link,
      }}
      submitting={saving}
      onDirtyChange={onDirtyChange}
      onCancel={onCancel}
      onSubmit={save}
    />
  );
}

async function deleteForwardedLead(
  lead: Row,
  auth: ReturnType<typeof useAuth>,
  qc: ReturnType<typeof useQueryClient>,
) {
  const isAdmin = auth.primaryRole === "admin" || auth.primaryRole === "sub_admin";
  if (!isAdmin && (lead.cs_status !== "new" || lead.created_by !== auth.user?.id)) {
    toast.error("You can only delete your own pending leads.");
    return;
  }
  if (!confirm(`Delete lead for "${lead.customer_name}"? This cannot be undone.`)) return;
  try {
    const { error } = await supabase.from("qualified_leads").delete().eq("id", lead.id);
    if (error) throw error;
    void syncLeadToGoogleSheet("DELETE", lead);
    await supabase.from("activity_logs").insert({
      actor_id: auth.user?.id,
      actor_name: auth.profile?.full_name,
      actor_role: auth.primaryRole,
      action: "forwarded.deleted",
      entity_type: "qualified_lead",
      entity_id: lead.id,
      metadata: { customer_name: lead.customer_name },
    });
    toast.success("Forwarded lead deleted");
    qc.invalidateQueries({ queryKey: ["forwarded-leads"] });
    qc.invalidateQueries({ queryKey: ["forwarded-sent-today"] });
  } catch (err) {
    toast.error(friendlyError(err));
  }
}
