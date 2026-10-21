import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { autoRephraseLeadWithAi } from "@/lib/raw-leads-ai.functions";
import { toast } from "sonner";
import {
  formatDistanceToNow,
  format,
  startOfDay,
  endOfDay,
  subDays,
  addDays,
  startOfWeek,
  startOfMonth,
} from "date-fns";
import {
  ImagePlus,
  CheckCircle2,
  Plus,
  TrendingUp,
  CalendarDays,
  Send,
  FolderOpen,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { syncLeadToGoogleSheet } from "@/lib/google-sheets-sync";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { LeadForm, type LeadFormValues, type LeadReferenceMode } from "@/components/lead-form";
import { uploadLeadImages } from "@/lib/lead-form-utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  roleToBaseGroup,
  fetchBasesForRole,
  isLeadInBase,
  resolveEnforcement,
  type EnforcementMode,
} from "@/lib/service-area-base";
import { SignedLeadImage } from "@/lib/lead-attachments.tsx";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toPktWallClockDate, pktNextMidnight } from "@/lib/timezone";
import type { DateRange } from "react-day-picker";
import { formatPhone } from "@/lib/crm-lite";
const DraftsDialog = lazy(() =>
  import("@/components/drafts-dialog").then((m) => ({ default: m.DraftsDialog })),
);
import { saveDraft, deleteDraft, countMyDrafts, type LeadDraft } from "@/lib/lead-drafts";
import { friendlyError } from "@/lib/error-messages";

export const Route = createFileRoute("/app/submit-lead")({
  head: () => ({
    meta: [
      { title: "Manual Lead \u00b7 JellyBean" },
      { name: "description", content: "Submit customer leads to the JellyBean CS pipeline." },
      { property: "og:title", content: "Manual Lead \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Submit customer leads to the JellyBean CS pipeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const auth = useAuth();
  return (
    <RoleGate
      allow={["facebook", "seo", "admin", "sub_admin", "maturing", "acc_handler"]}
      current={auth.primaryRole}
    >
      <Dashboard />
    </RoleGate>
  );
}

type LeadRow = {
  id: string;
  customer_name: string;
  customer_number: string;
  service: string | null;
  main_area: string | null;
  context: string | null;
  cs_status: string;
  created_at: string;
  images: string[];
};

function Dashboard() {
  const auth = useAuth();
  const role = auth.primaryRole ?? "submitter";
  const isFacebook = role === "facebook";

  const getToday = () => (isFacebook ? toPktWallClockDate(new Date()) : new Date());

  const [open, setOpen] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [activeDraft, setActiveDraft] = useState<LeadDraft | null>(null);
  const [range, setRange] = useState<DateRange | undefined>(() => {
    const today = getToday();
    return {
      from: subDays(today, 29),
      to: today,
    };
  });

  // Strict PKT live auto-sync exclusively for the Facebook role:
  // Automatically advance date range when midnight rolls over in Pakistan (00:00 PKT)
  // and when the browser tab becomes visible/focused.
  useEffect(() => {
    if (!isFacebook) return;

    const syncPktDate = () => {
      const currentPktToday = toPktWallClockDate(new Date());
      setRange((prev) => {
        if (!prev?.to) return prev;
        const prevToKey = format(prev.to, "yyyy-MM-dd");
        const currentTodayKey = format(currentPktToday, "yyyy-MM-dd");
        if (prevToKey !== currentTodayKey) {
          const diffDays = Math.max(
            1,
            prev.from
              ? Math.round((prev.to.getTime() - prev.from.getTime()) / (1000 * 60 * 60 * 24))
              : 29,
          );
          return {
            from: subDays(currentPktToday, diffDays),
            to: currentPktToday,
          };
        }
        return prev;
      });
    };

    // Run sync on mount/focus to immediately correct any stale date if tab stayed open
    syncPktDate();

    let timer: NodeJS.Timeout;
    const scheduleMidnight = () => {
      const nextMid = pktNextMidnight();
      const delay = Math.max(1000, nextMid.getTime() - Date.now() + 500);
      timer = setTimeout(() => {
        syncPktDate();
        scheduleMidnight();
      }, delay);
    };

    scheduleMidnight();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        syncPktDate();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
    };
  }, [isFacebook]);

  const draftCountQuery = useQuery({
    queryKey: ["lead-drafts-count", auth.user?.id, "manual_lead"],
    queryFn: () => countMyDrafts(auth.user!.id, "manual_lead"),
    enabled: !!auth.user?.id,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const hasDraftLeads = (draftCountQuery.data ?? 0) > 0;

  const all = useQuery({
    queryKey: ["my-submitted-leads", auth.user?.id],
    enabled: !!auth.user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qualified_leads")
        .select(
          "id, customer_name, customer_number, service, main_area, context, cs_status, created_at, images",
        )
        .eq("created_by", auth.user!.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as LeadRow[];
    },
  });

  const leads = useMemo(() => all.data ?? [], [all.data]);

  const stats = useMemo(() => {
    const now = isFacebook ? toPktWallClockDate(new Date()) : new Date();
    const todayStart = startOfDay(now);
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const monthStart = startOfMonth(now);
    const inRange = (d: Date, from: Date, to: Date) => d >= from && d <= to;

    let today = 0,
      week = 0,
      month = 0,
      ranged = 0;
    const byStatus: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const rFrom = range?.from ? startOfDay(range.from) : null;
    const rTo = range?.to ? endOfDay(range.to) : range?.from ? endOfDay(range.from) : null;

    for (const lead of leads) {
      const d = isFacebook ? toPktWallClockDate(lead.created_at) : new Date(lead.created_at);
      if (d >= todayStart) today++;
      if (d >= weekStart) week++;
      if (d >= monthStart) month++;
      if (rFrom && rTo && inRange(d, rFrom, rTo)) {
        ranged++;
        const key = format(d, "yyyy-MM-dd");
        byDay[key] = (byDay[key] ?? 0) + 1;
        byStatus[lead.cs_status] = (byStatus[lead.cs_status] ?? 0) + 1;
      }
    }

    const series: { date: string; label: string; count: number }[] = [];
    if (rFrom && rTo) {
      const days = Math.min(
        90,
        Math.floor((rTo.getTime() - rFrom.getTime()) / (1000 * 60 * 60 * 24)) + 1,
      );
      for (let i = 0; i < days; i++) {
        const d = addDays(rFrom, i);
        const key = format(d, "yyyy-MM-dd");
        series.push({ date: key, label: format(d, "MMM d"), count: byDay[key] ?? 0 });
      }
    }
    const max = series.reduce((m, s) => Math.max(m, s.count), 0);
    return { today, week, month, ranged, series, max, byStatus };
  }, [leads, range, isFacebook]);

  const rangeLabel = range?.from
    ? range.to
      ? `${format(range.from, "MMM d")} - ${format(range.to, "MMM d, yyyy")}`
      : format(range.from, "MMM d, yyyy")
    : "Pick a date range";

  return (
    <div>
      <PageHeader
        title="My submitted leads"
        description={`Track the leads you sent to CS${role === "facebook" || role === "seo" ? ` as ${role.toUpperCase()}` : ""}.`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="relative"
              onClick={() => setDraftsOpen(true)}
            >
              <FolderOpen className="h-4 w-4 mr-1.5" />
              Drafts
              {hasDraftLeads && (
                <span
                  className="absolute -top-1.5 -right-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white ring-2 ring-background"
                  aria-label={`${draftCountQuery.data} draft leads`}
                  title={`${draftCountQuery.data} draft leads`}
                >
                  {draftCountQuery.data}
                </span>
              )}
            </Button>
            <Dialog
              open={open}
              onOpenChange={(newOpen) => {
                if (
                  !newOpen &&
                  isDirty &&
                  !window.confirm("You have unsaved changes. Are you sure you want to close?")
                )
                  return;
                setOpen(newOpen);
                if (!newOpen) setActiveDraft(null);
              }}
            >
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-1.5" />
                  New lead
                </Button>
              </DialogTrigger>
              <DialogContent
                className="max-w-2xl max-h-[90vh] overflow-y-auto"
                aria-describedby={undefined}
                onInteractOutside={(e) => e.preventDefault()}
              >
                <DialogHeader>
                  <DialogTitle>
                    {activeDraft ? "Send lead to CS (Draft)" : "Send a new lead to CS"}
                  </DialogTitle>
                </DialogHeader>
                <SubmitForm
                  key={activeDraft?.id ?? "new"}
                  role={role}
                  initialDraft={activeDraft}
                  onDone={() => {
                    setOpen(false);
                    setIsDirty(false);
                    setActiveDraft(null);
                  }}
                  onDirtyChange={setIsDirty}
                />
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      <PageBody className="space-y-6">
        <div className="crm-section-panel">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard
              label="Today"
              value={all.isLoading ? null : stats.today}
              icon={<Send className="h-4 w-4 text-foreground" />}
            />
            <StatCard
              label="This week"
              value={all.isLoading ? null : stats.week}
              icon={<CalendarDays className="h-4 w-4 text-primary-glow" />}
            />
            <StatCard
              label="This month"
              value={all.isLoading ? null : stats.month}
              icon={<TrendingUp className="h-4 w-4 text-success" />}
            />
            <StatCard
              label="All time"
              value={all.isLoading ? null : leads.length}
              icon={<CheckCircle2 className="h-4 w-4 text-warning" />}
            />
          </div>
        </div>

        <div className="crm-section-panel">
          <div className="glass-card p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-semibold">Leads in range</div>
                <div className="text-xs text-muted-foreground">{rangeLabel}</div>
              </div>
              <div className="flex items-center gap-2">
                <QuickRange
                  label="7d"
                  onClick={() => {
                    const today = getToday();
                    setRange({ from: subDays(today, 6), to: today });
                  }}
                />
                <QuickRange
                  label="30d"
                  onClick={() => {
                    const today = getToday();
                    setRange({ from: subDays(today, 29), to: today });
                  }}
                />
                <QuickRange
                  label="90d"
                  onClick={() => {
                    const today = getToday();
                    setRange({ from: subDays(today, 89), to: today });
                  }}
                />
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm">
                      <CalendarDays className="h-3.5 w-3.5 mr-1.5" />
                      Custom
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="end">
                    <Calendar
                      mode="range"
                      selected={range}
                      onSelect={setRange}
                      today={isFacebook ? toPktWallClockDate(new Date()) : undefined}
                      numberOfMonths={2}
                      className={cn("p-3 pointer-events-auto")}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="flex items-end gap-4">
              <div className="text-3xl font-bold tabular-nums">{stats.ranged}</div>
              <div className="text-xs text-muted-foreground pb-1">leads in selected range</div>
            </div>

            <div className="h-40 flex items-end gap-1 border-b border-border-strong pb-1">
              {stats.series.length === 0 ? (
                <div className="text-xs text-muted-foreground self-center mx-auto">
                  Pick a date range to see daily trend.
                </div>
              ) : (
                stats.series.map((seriesItem) => {
                  const h = stats.max > 0 ? (seriesItem.count / stats.max) * 100 : 0;
                  return (
                    <div
                      key={seriesItem.date}
                      className="flex-1 group relative flex flex-col items-center justify-end h-full"
                    >
                      <div
                        className="w-full bg-primary/80 hover:bg-primary rounded-t transition-colors min-h-[2px]"
                        style={{ height: `${h}%` }}
                        title={`${seriesItem.label}: ${seriesItem.count}`}
                      />
                    </div>
                  );
                })
              )}
            </div>
            {stats.series.length > 0 && (
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>{stats.series[0].label}</span>
                <span>{stats.series[stats.series.length - 1].label}</span>
              </div>
            )}

            {Object.keys(stats.byStatus).length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                {Object.entries(stats.byStatus).map(([key, value]) => (
                  <div
                    key={key}
                    className="text-[11px] px-2.5 py-1 rounded-full bg-muted border border-border"
                  >
                    <span className="uppercase tracking-wide text-muted-foreground mr-1.5">
                      {key}
                    </span>
                    <span className="font-semibold tabular-nums">{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="crm-section-panel">
          <h2 className="text-sm font-semibold mb-3">Recent submissions</h2>
          {all.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : leads.length === 0 ? (
            <div className="text-sm text-muted-foreground glass-card p-6 text-center">
              No leads submitted yet. Click <strong>New lead</strong> to send your first one.
            </div>
          ) : (
            <div className="space-y-2">
              {leads.slice(0, 30).map((lead) => (
                <div key={lead.id} className="glass-card p-3 flex items-start gap-3">
                  {Array.isArray(lead.images) && lead.images.length > 0 ? (
                    <SignedLeadImage
                      refValue={lead.images[0]}
                      className="h-12 w-12 rounded object-cover border border-border shrink-0"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded bg-muted border border-border shrink-0 grid place-items-center text-muted-foreground">
                      <ImagePlus className="h-4 w-4 opacity-50" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-sm truncate">{lead.customer_name}</div>
                      <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-muted border border-border text-muted-foreground">
                        {lead.cs_status}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {lead.customer_number}
                      {lead.service && ` - ${lead.service}`}
                      {lead.main_area && ` - ${lead.main_area}`}
                    </div>
                    <div className="text-[10.5px] text-muted-foreground/70 mt-0.5">
                      {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PageBody>
      {draftsOpen && (
        <Suspense fallback={null}>
          <DraftsDialog
            open={draftsOpen}
            onOpenChange={setDraftsOpen}
            filterSource="manual_lead"
            onOpenDraft={(d) => {
              setActiveDraft(d);
              setOpen(true);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | null;
  icon: React.ReactNode;
}) {
  return (
    <div className="crm-surface-card p-4">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-[10px] uppercase tracking-[0.18em] font-mono">{label}</span>
        {icon}
      </div>
      {value === null ? (
        <Skeleton className="mt-2 h-7 w-14" />
      ) : (
        <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      )}
    </div>
  );
}

function QuickRange({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} className="h-8 px-2.5 text-xs">
      {label}
    </Button>
  );
}

function SubmitForm({
  role,
  onDone,
  onDirtyChange,
  initialDraft,
}: {
  role: string;
  onDone: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  initialDraft?: LeadDraft | null;
}) {
  const auth = useAuth();
  const qc = useQueryClient();
  const autoRephraseFn = useServerFn(autoRephraseLeadWithAi);
  const [submitting, setSubmitting] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(initialDraft?.id ?? null);
  const baseGroup = roleToBaseGroup(role);
  const [pendingOob, setPendingOob] = useState<{
    values: LeadFormValues;
    mode: EnforcementMode;
  } | null>(null);
  const referenceMode: LeadReferenceMode =
    role === "facebook" ? "auto-fb" : role === "seo" ? "manual-text" : "manual-dropdown";
  const forwardedBy =
    auth.profile?.full_name ?? auth.profile?.username ?? auth.profile?.email ?? "Current user";

  const draftFd = initialDraft?.form_data ?? {};
  const initialValues = initialDraft
    ? {
        customerName: (draftFd.customerName as string) ?? "",
        customerNumber: (draftFd.customerNumber as string) ?? "",
        extraNumbers: (draftFd.extraNumbers as string[]) ?? [],
        area: (draftFd.area as string) ?? "",
        stateCode: (draftFd.stateCode as string) ?? "",
        service: (draftFd.service as string) ?? "",
        context: (draftFd.context as string) ?? "",
        exactCustomerText: (draftFd.exactCustomerText as string) ?? "",
        reference: (draftFd.reference as string) ?? "",
        isImportant: (draftFd.isImportant as boolean) ?? false,
        originalLeadLink: (draftFd.originalLeadLink as string | null) ?? null,
      }
    : undefined;

  async function handleSaveDraft(values: LeadFormValues) {
    if (!auth.user?.id) return;
    try {
      const saved = await saveDraft({
        id: draftId,
        source_type: "manual_lead",
        source_lead_id: null,
        created_by: auth.user.id,
        form_data: {
          customerName: values.customerName,
          customerNumber: values.customerNumber,
          extraNumbers: values.extraNumbers,
          area: values.area,
          stateCode: values.stateCode,
          service: values.service,
          context: values.context,
          exactCustomerText: values.exactCustomerText,
          reference: values.reference,
          isImportant: values.isImportant,
          role,
        },
      });
      setDraftId(saved.id);
      qc.invalidateQueries({ queryKey: ["lead-drafts-count"] });
      toast.success("Draft saved");
    } catch (err) {
      toast.error(friendlyError(err));
    }
  }

  async function doInsert(values: LeadFormValues, outOfBase: boolean, mode: EnforcementMode) {
    if (!auth.user?.id) return;
    setSubmitting(true);
    try {
      const imageUrls =
        values.files.length > 0
          ? await uploadLeadImages({ files: values.files, userId: auth.user.id, supabase })
          : [];
      const cleanedExtras = (values.extraNumbers || [])
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => formatPhone(p) || p);
      // Only reference the out_of_base column when a lead is actually out of
      // base. Out-of-base can only happen once base rules exist (which requires
      // this feature's migration), so the common in-base path stays compatible
      // even if the frontend deploys slightly ahead of the migration.
      const insertPayload: Record<string, unknown> = {
        customer_name: values.customerName,
        customer_number: values.customerNumber,
        customer_number_2: cleanedExtras[0] ?? null,
        extra_numbers: cleanedExtras,
        service: values.service,
        pass_it_to: role === "facebook" || role === "seo" ? null : values.service,
        main_area: values.area || null,
        sub_area: values.area || null,
        context: values.context,
        post_text: values.exactCustomerText,
        reference: values.reference,
        images: imageUrls,
        submitted_by_role: role,
        is_important: values.isImportant,
        pinned_important: values.isImportant,
        created_by: auth.user.id,
        assigned_by: auth.user.id,
        cs_status: outOfBase && mode === "status" ? "out_of_base" : "new",
        state_code: values.stateCode || null,
        is_landline: values.isLandline,
      };
      if (outOfBase) insertPayload.out_of_base = true;
      const { data: insertedLead, error } = await supabase
        .from("qualified_leads")
        .insert(insertPayload as never)
        .select("id")
        .maybeSingle();
      if (error) throw error;

      if (insertedLead?.id) {
        void syncLeadToGoogleSheet("INSERT", {
          id: insertedLead.id,
          customer_name: values.customerName,
          customer_number: values.customerNumber,
          customer_number_2: cleanedExtras[0] ?? null,
          service: values.service,
          main_area: values.area || null,
          sub_area: values.area || null,
          context: values.context,
          requirement_1: values.exactCustomerText,
          created_at: new Date().toISOString(),
          is_important: values.isImportant,
          pinned_important: values.isImportant,
          cs_status: "new",
        });
        void autoRephraseFn({ data: { leadId: insertedLead.id } }).catch((err) => {
          console.error("[Auto-rephrase] Failed for submitted lead:", insertedLead.id, err);
        });
      }
      await supabase.from("activity_logs").insert({
        actor_id: auth.user.id,
        actor_name:
          auth.profile?.full_name ?? auth.profile?.username ?? auth.profile?.email ?? null,
        actor_role: auth.primaryRole,
        action: "lead.submitted_to_cs",
        entity_type: "qualified_lead",
        metadata: {
          customer_name: values.customerName,
          customer_number: values.customerNumber,
          area: values.area || null,
          reference: values.reference,
          submitted_by_role: role,
        },
      });
      if (draftId) {
        try {
          await deleteDraft(draftId);
        } catch {
          // best-effort
        }
      }
      toast.success("Lead sent to CS");
      qc.invalidateQueries({ queryKey: ["my-submitted-leads"] });
      qc.invalidateQueries({ queryKey: ["lead-drafts-count"] });
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // Entry point from the form. For FB / SEO / ND submitters, check the lead
  // against the active Service/Area Base first. Out-of-base leads trigger a
  // warning (but can still be added); everything else inserts immediately.
  async function submit(values: LeadFormValues) {
    if (!auth.user?.id) return;
    if (baseGroup) {
      setSubmitting(true);
      let inBase = true;
      let mode: EnforcementMode = "warn";
      try {
        const bases = await fetchBasesForRole(baseGroup);
        inBase = isLeadInBase({
          bases,
          service: values.service,
          stateCode: values.stateCode,
          city: values.area,
        });
        mode = resolveEnforcement(bases);
      } catch (err) {
        // If the base check fails, don't block the submission — treat as in-base.
        console.error("[ServiceAreaBase] check failed:", err);
        inBase = true;
      } finally {
        setSubmitting(false);
      }
      if (!inBase) {
        setPendingOob({ values, mode });
        return;
      }
    }
    await doInsert(values, false, "warn");
  }

  return (
    <>
      <LeadForm
        title="Send a new lead to CS"
        submitLabel="Send to CS"
        forwardedBy={forwardedBy}
        showAttachments
        areaRequired={role !== "seo"}
        showState
        stateRequired={baseGroup !== null && baseGroup !== "seo"}
        referenceMode={referenceMode}
        submitting={submitting}
        onDirtyChange={onDirtyChange}
        onCancel={onDone}
        onSubmit={submit}
        onSaveDraft={handleSaveDraft}
        initialValues={initialValues}
      />
      <AlertDialog
        open={!!pendingOob}
        onOpenChange={(open) => {
          if (!open) setPendingOob(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lead is outside your Service/Area Base</AlertDialogTitle>
            <AlertDialogDescription>
              This lead's service and area don't match the acceptable base set for your role. You
              can still add it — it will be tagged <strong>Out of Base</strong>
              {pendingOob?.mode === "status"
                ? " and moved to the Out of Base status for review"
                : ""}
              . Add it anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(e) => {
                e.preventDefault();
                if (!pendingOob) return;
                const { values, mode } = pendingOob;
                setPendingOob(null);
                void doInsert(values, true, mode);
              }}
            >
              Add anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
