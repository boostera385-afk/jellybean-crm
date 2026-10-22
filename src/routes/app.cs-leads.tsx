import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RouteSkeleton } from "@/components/route-skeleton";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@/hooks/use-auth";
import { syncLeadToGoogleSheet } from "@/lib/google-sheets-sync";
import { useSignedLeadUrls } from "@/lib/lead-attachments";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Loader2,
  Phone,
  MapPin,
  MessageSquarePlus,
  MessageSquareText,
  ArrowRight,
  Search,
  RefreshCw,
  UserPlus,
  UserCheck,
  Download,
  Bell,
  BellOff,
  Trash2,
  ArrowRightCircle,
  CalendarDays,
  LayoutGrid,
  Table2,
  X,
  Sparkles,
  Copy,
  Check,
  Pin,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Paperclip,
  ExternalLink,
  Warehouse,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  csPipelineDateRangeToUtcIso,
  csPipelineDateKeyRangeToUtcIso,
  csPipelineRelativeDateRange,
  csPipelineInputValueToUtcIso,
  formatCsPipelineCalendarDateWithYear,
  formatCsPipelineCalendarShortDate,
  formatCsPipelineDateTime,
  utcIsoToCsPipelineInputValue,
  useCsPipelineEasternDateKey,
  type CsPipelineRelativePreset,
} from "@/lib/cs-pipeline-time";
import type { DateRange } from "react-day-picker";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { listCsTeam, bulkAssignImportantLeads, type CsTeamMember } from "@/lib/cs-team.functions";
import { downloadCsv, formatPhone, phoneSearchPattern, phoneDigitsMatch } from "@/lib/crm-lite";
import type { CsStatus, LeadNote } from "@/lib/crm-types";
import { NumberNameSelect } from "@/components/number-name-select";
import { STATUS_LABEL, STATUS_TONE, pinnedImportantFor } from "@/lib/lead-statuses";
import { renderCsComposeSuggestion } from "@/lib/cs-compose-template";
import { rephraseLeadTemplateWithAi, autoRephraseLeadWithAi } from "@/lib/raw-leads-ai.functions";
import { SERVICE_CATEGORIES } from "@/data/service-options";

import { cn } from "@/lib/utils";
import { confirmDiscardUnsaved } from "@/components/confirm-dialog-store";

// Garage Door filter: match specific phrases (case-insensitive) across
// service/pass_it_to and lead text fields. Avoids bare "garage" which
// would incorrectly include garage remodeling/cleaning/flooring leads.
const GARAGE_DOOR_PATTERNS = ["%garage door%", "%garage opener%", "%overhead door%"];
const GARAGE_DOOR_FIELDS = [
  "service",
  "pass_it_to",
  "context",
  "post_text",
  "requirement_1",
  "requirement_2",
];
const GARAGE_DOOR_OR_CLAUSE = GARAGE_DOOR_FIELDS.flatMap((f) =>
  GARAGE_DOOR_PATTERNS.map((p) => `${f}.ilike.${p}`),
).join(",");

type ContactMethod = "texted" | "called";
type NotCalledFilter = "__off__" | "__all__" | CsStatus;

function formatLeadServiceLabel(service: string | null): string | null {
  if (!service) return null;

  for (const group of SERVICE_CATEGORIES) {
    if (group.services.some((option) => option === service)) {
      return `${group.category} / ${service}`;
    }
  }

  return service;
}

export const Route = createFileRoute("/app/cs-leads")({
  head: () => ({
    meta: [
      { title: "CS Pipeline \u00b7 JellyBean" },
      {
        name: "description",
        content: "Manage customer leads, delivery outcomes, and follow-ups in JellyBean.",
      },
      { property: "og:title", content: "CS Pipeline \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Manage customer leads, delivery outcomes, and follow-ups in JellyBean.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
  validateSearch: (search: Record<string, unknown>): { leadId?: string } =>
    typeof search.leadId === "string" ? { leadId: search.leadId } : {},
});

const UNASSIGNED_VALUE = "__unassigned__";

async function copyToClipboard(value: string, label = "Copied") {
  const next = value.trim();
  if (!next) return;
  try {
    await navigator.clipboard.writeText(next);
    toast.success(label);
  } catch {
    toast.error("Could not copy");
  }
}

function playNotificationBeep() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const beep = (freq: number, start: number, dur: number, vol = 0.6) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.02);
    };
    // Loud three-tone alert chime, repeated three times — clearly audible
    // even when CS has another tab focused.
    for (let i = 0; i < 3; i++) {
      const t0 = i * 1.0;
      beep(880, t0 + 0.0, 0.22);
      beep(1175, t0 + 0.22, 0.22);
      beep(1568, t0 + 0.46, 0.38);
    }
    setTimeout(() => ctx.close(), 3500);
  } catch {
    // ignore — autoplay may be blocked until user interacts
  }
}

function showBrowserNotification(title: string, body: string) {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, {
      body,
      icon: "/favicon.ico",
      tag: "cs-new-lead",
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* ignore */
  }
}

type Lead = {
  id: string;
  customer_name: string;
  customer_number: string;
  customer_number_2: string | null;
  context: string | null;
  post_text: string | null;
  pass_it_to: string | null;
  main_area: string | null;
  sub_area: string | null;
  marketing_notes: string | null;
  requirement_1: string | null;
  requirement_2: string | null;
  number_name: string | null;
  original_lead_link: string | null;
  cs_status: CsStatus;
  contact_method: ContactMethod | null;
  called_at: string | null;
  cs_notes: LeadNote[];
  followup_at: string | null;
  assigned_at: string;
  assigned_to: string | null;
  is_important: boolean;
  pinned_important: boolean;
  service: string | null;
  images: string[];
  submitted_by_role: string | null;
  created_by: string | null;
  assigned_by: string | null;
  reference: string | null;
  is_landline: boolean;
  out_of_base: boolean;
};

// CS pipeline statuses surfaced in the UI (subset of the DB enum).
const PIPELINE_STATUSES = [
  "new",
  "out_of_base",
  "undeliver",
  "wrong_number",
  "wrong_lead",
  "wrong_service",
  "wrong_person",
  "already_got_someone",
  "already_received_before",
  "service_provider_himself",
  "small_service",
  "converted",
  "cx_interested",
  "cx_not_interested",
  "cx_didnt_replied",
  "need_follow_up",
] as const satisfies readonly CsStatus[];

type ComposeTemplateItem = {
  id: string;
  name: string;
  template: string;
};

const CS_COMPOSE_TEMPLATES_LIST_KEY = "cs_compose_templates_list";

const DEFAULT_COMPOSE_TEMPLATES: ComposeTemplateItem[] = [
  {
    id: "schedule_visit",
    name: "Schedule Visit",
    template:
      "Hi (Person first name), this is Alex. Saw that you are looking for (Service Context). Can you tell me more about what you need so I can check our schedule for a visit?",
  },
  {
    id: "price_estimate",
    name: "Request Estimate Details",
    template:
      "Hello (Person first name), I saw your post looking for (Service Context). We can definitely help you with that! Could you share a few details so we can get you a price estimate?",
  },
  {
    id: "call_request",
    name: "Call Request",
    template:
      "Hi (Person first name), saw your request for (Service Context). What is the best number or time to call you to discuss details and schedule?",
  },
  {
    id: "follow_up",
    name: "Quick Follow-up",
    template:
      "Hi (Person first name), checking in regarding your request for (Service Context). Are you still looking to get this scheduled?",
  },
];

function useCsComposeTemplatesList(userId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["shared_state", CS_COMPOSE_TEMPLATES_LIST_KEY],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_state")
        .select("value")
        .eq("key", CS_COMPOSE_TEMPLATES_LIST_KEY)
        .maybeSingle();
      if (error) throw error;
      if (
        data?.value &&
        typeof data.value === "object" &&
        !Array.isArray(data.value) &&
        "templates" in data.value
      ) {
        const rawTemplates = data.value.templates;
        if (Array.isArray(rawTemplates)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (rawTemplates as any[]).filter(
            (t) =>
              t &&
              typeof t === "object" &&
              typeof t.id === "string" &&
              typeof t.name === "string" &&
              typeof t.template === "string",
          ) as ComposeTemplateItem[];
        }
      }
      return [];
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel(`cs-compose-templates-list-sync-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shared_state",
          filter: `key=eq.${CS_COMPOSE_TEMPLATES_LIST_KEY}`,
        },
        () => qc.invalidateQueries({ queryKey: ["shared_state", CS_COMPOSE_TEMPLATES_LIST_KEY] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  const save = async (templates: ComposeTemplateItem[]) => {
    const { error } = await supabase.from("shared_state").upsert({
      key: CS_COMPOSE_TEMPLATES_LIST_KEY,
      value: { templates },
      updated_by: userId ?? null,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    await qc.invalidateQueries({ queryKey: ["shared_state", CS_COMPOSE_TEMPLATES_LIST_KEY] });
  };

  const templates = Array.isArray(query.data) ? query.data : [];
  return { ...query, templates, save };
}

const CS_AUTO_REPHRASE_ENABLED_KEY = "cs_auto_rephrase_enabled";

function useCsAutoRephraseToggle(userId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["shared_state", CS_AUTO_REPHRASE_ENABLED_KEY],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_state")
        .select("value")
        .eq("key", CS_AUTO_REPHRASE_ENABLED_KEY)
        .maybeSingle();
      if (error) throw error;
      if (
        data?.value &&
        typeof data.value === "object" &&
        !Array.isArray(data.value) &&
        "enabled" in data.value
      ) {
        return Boolean((data.value as { enabled?: boolean }).enabled);
      }
      return false; // Default is OFF
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    const channel = supabase
      .channel(`cs-auto-rephrase-toggle-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shared_state",
          filter: `key=eq.${CS_AUTO_REPHRASE_ENABLED_KEY}`,
        },
        () => qc.invalidateQueries({ queryKey: ["shared_state", CS_AUTO_REPHRASE_ENABLED_KEY] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  const setEnabled = async (enabled: boolean) => {
    qc.setQueryData(["shared_state", CS_AUTO_REPHRASE_ENABLED_KEY], enabled);
    const { error } = await supabase.from("shared_state").upsert({
      key: CS_AUTO_REPHRASE_ENABLED_KEY,
      value: { enabled },
      updated_by: userId ?? null,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      qc.invalidateQueries({ queryKey: ["shared_state", CS_AUTO_REPHRASE_ENABLED_KEY] });
      throw error;
    }
  };

  return {
    enabled: Boolean(query.data),
    isLoading: query.isLoading,
    setEnabled,
  };
}

function Page() {
  const auth = useAuth();
  const isCs = auth.primaryRole === "cs";
  return (
    <div>
      <PageHeader
        title={isCs ? "Dashboard" : "CS Pipeline"}
        description="Qualified leads handed off to CS — reach out, log the outcome, and add a comment."
      />
      <PageBody className="!pt-5">
        <RoleGate allow={["admin", "cs", "cs_admin"]} current={auth.primaryRole}>
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const auth = useAuth();
  const qc = useQueryClient();
  const autoRephraseToggle = useCsAutoRephraseToggle(auth.user?.id);
  const autoRephraseEnabledRef = useRef(autoRephraseToggle.enabled);
  useEffect(() => {
    autoRephraseEnabledRef.current = autoRephraseToggle.enabled;
  }, [autoRephraseToggle.enabled]);

  const [newLeadCount, setNewLeadCount] = useState(0);
  const clearAlert = () => setNewLeadCount(0);
  const [query, setQuery] = useState("");
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

  const [ownerFilter, setOwnerFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [garageDoorOnly, setGarageDoorOnly] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [activeDatePreset, setActiveDatePreset] = useState<CsPipelineRelativePreset | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [activeStatus, setActiveStatus] = useState<CsStatus | "__all__" | "templates">("__all__");
  const [opened, setOpened] = useState<Lead | null>(null);
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [notCalledOnly, setNotCalledOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAssignee, setBulkAssignee] = useState<string>("");
  const [importantAssignee, setImportantAssignee] = useState<string>("");
  const [importantConfirmOpen, setImportantConfirmOpen] = useState(false);
  const [importantBusy, setImportantBusy] = useState(false);
  const isCs = auth.primaryRole === "cs";
  const isAdmin = auth.primaryRole === "admin" || auth.primaryRole === "cs_admin";
  const composeTemplatesList = useCsComposeTemplatesList(auth.user?.id);

  const rephraseFn = useServerFn(rephraseLeadTemplateWithAi);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  async function bulkAssign(nextAssignee: string | null) {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      const CHUNK = 25;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { error } = await supabase
          .from("qualified_leads")
          .update({
            assigned_to: nextAssignee,
            assigned_by: nextAssignee ? auth.user?.id : null,
          } as never)
          .in("id", slice);
        if (error) throw error;
      }
      const assigneeName = nextAssignee
        ? (teamById.get(nextAssignee)?.full_name ?? teamById.get(nextAssignee)?.email ?? "CS")
        : "Unassigned";
      toast.success(`Assigned ${ids.length} lead${ids.length === 1 ? "" : "s"} to ${assigneeName}`);
      const updatedLeads = (list.data ?? []).filter((l) => selectedIds.has(l.id));
      for (const l of updatedLeads) {
        void syncLeadToGoogleSheet("UPDATE", {
          ...l,
          assigned_to: nextAssignee,
          assigned_to_name: assigneeName,
        });
      }
      clearSelection();
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkAssignToMe() {
    if (!auth.user?.id) return;
    await bulkAssign(auth.user.id);
  }

  async function bulkAssignAsAdmin() {
    await bulkAssign(bulkAssignee === UNASSIGNED_VALUE ? null : bulkAssignee);
  }

  // ── Date filter values pushed to DB ──────────────────────────────────────
  // assigned_at is indexed (idx_qualified_leads_assigned_at DESC) so these
  // range filters are efficient. We compute the ISO strings in a memo so
  // they're stable across renders and don't cause spurious query key changes.
  const { fromIso: dbDateFrom, toIso: dbDateTo } = useMemo(
    () => csPipelineDateRangeToUtcIso(dateRange?.from ?? null, dateRange?.to ?? null),
    [dateRange?.from, dateRange?.to],
  );

  // ── Owner filter value for DB (indexed on assigned_to) ───────────────────
  const dbOwner = useMemo(() => {
    if (ownerFilter === "mine") return auth.user?.id ?? null;
    if (ownerFilter === "unassigned") return "__unassigned__";
    if (ownerFilter !== "all") return ownerFilter; // specific user ID
    return null; // all
  }, [ownerFilter, auth.user?.id]);

  // ── Status filter for DB (cs_status indexed via idx_qualified_leads_status_created) ──
  const dbStatus = useMemo(
    () =>
      activeStatus === "__all__" || activeStatus === "templates"
        ? null
        : (activeStatus as CsStatus),
    [activeStatus],
  );

  // ── Reset page to 1 whenever any server-side filter changes ──────────────
  useEffect(() => {
    setPage(1);
  }, [
    dbDateFrom,
    dbDateTo,
    dbOwner,
    dbStatus,
    areaFilter,
    dbSearch,
    garageDoorOnly,
    notCalledOnly,
  ]);

  const list = useQuery({
    queryKey: [
      "cs_leads",
      { page, dbDateFrom, dbDateTo, dbOwner, dbStatus, dbSearch, garageDoorOnly, notCalledOnly },
    ],
    queryFn: async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = supabase
        .from("qualified_leads")
        .select(
          "id, customer_name, customer_number, customer_number_2, context, post_text, pass_it_to, main_area, sub_area, marketing_notes, requirement_1, requirement_2, number_name, original_lead_link, cs_status, cs_notes, followup_at, assigned_at, assigned_to, assigned_by, created_by, is_important, pinned_important, service, reference, images, submitted_by_role, is_landline, out_of_base, contact_method, called_at",
        )
        .order("pinned_important", { ascending: false })
        .order("assigned_at", { ascending: false })
        .range(from, to);

      // Date range — pushed to DB (assigned_at is indexed)
      if (dbDateFrom) q = q.gte("assigned_at", dbDateFrom);
      if (dbDateTo) q = q.lt("assigned_at", dbDateTo);

      // Owner filter — pushed to DB (assigned_to is indexed)
      if (dbOwner === "__unassigned__") {
        q = q.is("assigned_to", null);
      } else if (dbOwner !== null) {
        q = q.eq("assigned_to", dbOwner);
      }

      // Status filter — pushed to DB (cs_status+created_at is indexed)
      if (dbStatus) q = q.eq("cs_status", dbStatus);

      if (notCalledOnly) q = q.is("called_at", null);

      // Search text filter — pushed to DB across all pages
      if (dbSearch) {
        const s = `%${dbSearch}%`;
        // Phone columns use a separator-agnostic pattern so a digits-only query
        // matches formatted stored numbers (and vice versa). Falls back to the
        // literal pattern for non-numeric queries.
        const phone = phoneSearchPattern(dbSearch) ?? s;
        q = q.or(
          `customer_name.ilike.${s},customer_number.ilike.${phone},customer_number_2.ilike.${phone},number_name.ilike.${s},main_area.ilike.${s},sub_area.ilike.${s},pass_it_to.ilike.${s},requirement_1.ilike.${s},requirement_2.ilike.${s}`,
        );
      }

      if (garageDoorOnly) {
        q = q.or(GARAGE_DOOR_OR_CLAUSE);
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Lead[];
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // ── Deep-link: open a specific lead via ?leadId=... (used by reminder notifier) ──
  const { leadId: deepLinkLeadId } = Route.useSearch();
  const navigate = useNavigate();
  const handledLeadIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkLeadId) return;
    if (handledLeadIdRef.current === deepLinkLeadId) return;
    handledLeadIdRef.current = deepLinkLeadId;

    const stripParam = () => {
      void navigate({ to: "/app/cs-leads", search: {}, replace: true });
    };

    const inList = (list.data ?? []).find((l) => l.id === deepLinkLeadId);
    if (inList) {
      setOpened(inList);
      stripParam();
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from("qualified_leads")
        .select(
          "id, customer_name, customer_number, customer_number_2, context, post_text, pass_it_to, main_area, sub_area, marketing_notes, requirement_1, requirement_2, number_name, original_lead_link, cs_status, cs_notes, followup_at, assigned_at, assigned_to, assigned_by, created_by, is_important, pinned_important, service, reference, images, submitted_by_role, is_landline, out_of_base, contact_method, called_at",
        )
        .eq("id", deepLinkLeadId)
        .maybeSingle();
      if (error) {
        toast.error(friendlyError(error));
        stripParam();
        return;
      }
      if (!data) {
        toast.error("Lead not found");
        stripParam();
        return;
      }
      setOpened(data as unknown as Lead);
      stripParam();
    })();
  }, [deepLinkLeadId, list.data, navigate]);

  const clearDeepLink = () => {
    // URL is already cleaned when the lead was opened; nothing to do here.
    // Kept for call-site compatibility.
  };

  // ── Lightweight count query ───────────────────────────────────────────────
  // Counting qualified_leads was historically the #1 DB load. We now avoid the
  // query entirely for the two most common views:
  //   • no filters at all      → reuse the cached `cs_leads_status_counts` RPC
  //   • only a status selected → reuse the same cached RPC's per-status counts
  // A real count query only runs when a date/owner/search/garage filter is on.
  const needsCountQuery = Boolean(
    dbDateFrom || dbDateTo || dbOwner || dbSearch || garageDoorOnly || notCalledOnly,
  );

  const totalCount = useQuery({
    queryKey: [
      "cs_leads",
      "cs_leads_count",
      { dbDateFrom, dbDateTo, dbOwner, dbStatus, dbSearch, garageDoorOnly, notCalledOnly },
    ],
    enabled: needsCountQuery,
    queryFn: async () => {
      // This only runs when a narrow filter is active (see `needsCountQuery`),
      // so an exact count is affordable and accurate — indexed on assigned_at /
      // assigned_to. Unfiltered + status-only totals never reach this query.
      let q = supabase.from("qualified_leads").select("id", { count: "exact", head: true });

      if (dbDateFrom) q = q.gte("assigned_at", dbDateFrom);
      if (dbDateTo) q = q.lt("assigned_at", dbDateTo);

      if (dbOwner === "__unassigned__") {
        q = q.is("assigned_to", null);
      } else if (dbOwner !== null) {
        q = q.eq("assigned_to", dbOwner);
      }

      if (dbStatus) q = q.eq("cs_status", dbStatus);

      if (notCalledOnly) q = q.is("called_at", null);

      if (dbSearch) {
        const s = `%${dbSearch}%`;
        // Phone columns use a separator-agnostic pattern so a digits-only query
        // matches formatted stored numbers (and vice versa). Falls back to the
        // literal pattern for non-numeric queries.
        const phone = phoneSearchPattern(dbSearch) ?? s;
        q = q.or(
          `customer_name.ilike.${s},customer_number.ilike.${phone},customer_number_2.ilike.${phone},number_name.ilike.${s},main_area.ilike.${s},sub_area.ilike.${s},pass_it_to.ilike.${s},requirement_1.ilike.${s},requirement_2.ilike.${s}`,
        );
      }

      if (garageDoorOnly) {
        q = q.or(GARAGE_DOOR_OR_CLAUSE);
      }

      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const allTimeStatusCounts = useQuery({
    queryKey: ["cs_leads", "status_counts_all_time"],
    queryFn: async () => {
      // Single-query RPC: returns all totals + per-status counts in one
      // database scan. Previously this fired 5+ separate count(*) queries
      // per page load — the #1 DB load in the app.
      const { data, error } = await supabase.rpc("cs_leads_status_counts" as never);
      if (error) throw error;
      const payload = (data ?? {}) as { all?: number; statuses?: Record<string, number> };
      const countsByStatus: Record<string, number> = {};
      for (const status of PIPELINE_STATUSES) countsByStatus[status] = 0;
      for (const [k, v] of Object.entries(payload.statuses ?? {})) {
        countsByStatus[k] = Number(v ?? 0);
      }
      return {
        all: Number(payload.all ?? 0),
        statuses: countsByStatus,
      };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  // Exact database count of Garage Door leads matching current filters.
  // This is an 18-way ILIKE scan, so it only runs while the Garage Door filter
  // is actually switched on (it powers pagination there); the toolbar badge
  // shows no number when the filter is off.
  const garageDoorCount = useQuery({
    queryKey: [
      "cs_leads",
      "cs_garage_door_count",
      { dbDateFrom, dbDateTo, dbOwner, dbStatus, dbSearch, areaFilter, notCalledOnly },
    ],
    enabled: garageDoorOnly,
    queryFn: async () => {
      let q = supabase.from("qualified_leads").select("id", { count: "exact", head: true });

      if (dbDateFrom) q = q.gte("assigned_at", dbDateFrom);
      if (dbDateTo) q = q.lt("assigned_at", dbDateTo);

      if (dbOwner === "__unassigned__") {
        q = q.is("assigned_to", null);
      } else if (dbOwner !== null) {
        q = q.eq("assigned_to", dbOwner);
      }

      if (dbStatus) q = q.eq("cs_status", dbStatus);

      if (notCalledOnly) q = q.is("called_at", null);

      if (dbSearch) {
        const s = `%${dbSearch}%`;
        // Phone columns use a separator-agnostic pattern so a digits-only query
        // matches formatted stored numbers (and vice versa). Falls back to the
        // literal pattern for non-numeric queries.
        const phone = phoneSearchPattern(dbSearch) ?? s;
        q = q.or(
          `customer_name.ilike.${s},customer_number.ilike.${phone},customer_number_2.ilike.${phone},number_name.ilike.${s},main_area.ilike.${s},sub_area.ilike.${s},pass_it_to.ilike.${s},requirement_1.ilike.${s},requirement_2.ilike.${s}`,
        );
      }

      q = q.or(GARAGE_DOOR_OR_CLAUSE);

      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  // Total used for pagination. When no narrow filter is active we reuse the
  // cached status-count RPC instead of firing another count query.
  const cachedStatusTotal = dbStatus
    ? (allTimeStatusCounts.data?.statuses?.[dbStatus] ?? 0)
    : (allTimeStatusCounts.data?.all ?? 0);
  const effectiveTotalCount = garageDoorOnly
    ? (garageDoorCount.data ?? 0)
    : needsCountQuery
      ? (totalCount.data ?? 0)
      : cachedStatusTotal;

  const totalPages = Math.max(1, Math.ceil(effectiveTotalCount / PAGE_SIZE));

  const notCalledFilterValue: NotCalledFilter = notCalledOnly ? (dbStatus ?? "__all__") : "__off__";

  function changeNotCalledFilter(value: string) {
    const next = value as NotCalledFilter;
    if (next === "__off__") {
      setNotCalledOnly(false);
      return;
    }

    setNotCalledOnly(true);
    setActiveStatus(next === "__all__" ? "__all__" : next);
    setViewMode("table");
  }

  // ── Eastern-Time date rollover ─────────────────────────────────────────
  // `etDateKey` is a "YYYY-MM-DD" string (ET) that updates at the exact
  // America/New_York midnight, independent of the browser timezone.
  const etDateKey = useCsPipelineEasternDateKey();
  const todayStart = useMemo(
    () => csPipelineDateKeyRangeToUtcIso(etDateKey, etDateKey).fromIso ?? "",
    [etDateKey],
  );

  // ── Auto-slide preset date ranges at Eastern midnight ────────────────────
  const applyDatePreset = (preset: CsPipelineRelativePreset) => {
    setActiveDatePreset(preset);
    setDateRange(csPipelineRelativeDateRange(preset, etDateKey));
  };

  useEffect(() => {
    if (!activeDatePreset) return;
    setDateRange(() => csPipelineRelativeDateRange(activeDatePreset, etDateKey));
  }, [activeDatePreset, etDateKey]);

  const sentToday = useQuery({
    queryKey: ["cs_sent_today", auth.user?.id, todayStart],
    enabled: !!auth.user?.id,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("qualified_leads")
        .select("id", { count: "exact", head: true })
        .eq("assigned_by", auth.user!.id)
        .gte("assigned_at", todayStart);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // CS team — used to display assignee names and (for admins) to reassign.
  const listTeam = useServerFn(listCsTeam);
  const team = useQuery({
    queryKey: ["cs_team"],
    queryFn: () => listTeam(),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // Count of currently important leads (used to preview the bulk action).
  const importantCount = useQuery({
    queryKey: ["cs_leads_important_count"],
    enabled: isAdmin,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("qualified_leads")
        .select("id", { count: "planned", head: true })
        .eq("is_important", true);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const runBulkAssignImportant = useServerFn(bulkAssignImportantLeads);
  async function confirmBulkAssignImportant() {
    if (!importantAssignee) return;
    setImportantBusy(true);
    try {
      const res = await runBulkAssignImportant({ data: { assigneeId: importantAssignee } });
      const name = res.assignee.full_name || res.assignee.email || "CS user";
      if (res.count === 0) {
        toast.info("No important leads available to assign.");
      } else {
        toast.success(
          `${res.count} important lead${res.count === 1 ? "" : "s"} assigned to ${name}.`,
        );
      }
      setImportantConfirmOpen(false);
      setImportantAssignee("");
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
      qc.invalidateQueries({ queryKey: ["cs_leads_important_count"] });
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setImportantBusy(false);
    }
  }

  const teamById = useMemo(() => {
    const map = new Map<string, CsTeamMember>();
    for (const m of team.data ?? []) map.set(m.user_id, m);
    return map;
  }, [team.data]);

  const allProfiles = useQuery({
    queryKey: ["all_profiles"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("user_id, full_name, email");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const profilesById = useMemo(() => {
    const map = new Map<string, { full_name: string | null; email: string }>();
    for (const p of allProfiles.data ?? []) {
      map.set(p.user_id, { full_name: p.full_name, email: p.email });
    }
    return map;
  }, [allProfiles.data]);

  const dueLeads = useMemo(() => {
    if (!list.data) return [];
    const now = new Date();
    return list.data.filter((lead) => {
      if (!lead.followup_at) return false;
      return new Date(lead.followup_at) <= now && lead.cs_status === "need_follow_up";
    });
  }, [list.data]);

  const areaOptions = useMemo(() => {
    const areas = new Set<string>();
    for (const lead of list.data ?? []) {
      const area = lead.main_area?.trim() || lead.sub_area?.trim();
      if (area) areas.add(area);
    }
    return Array.from(areas).sort();
  }, [list.data]);

  // ── New-lead sound notification (Supabase Realtime — instant for every CS) ──
  // Listens for INSERT events on qualified_leads. Every signed-in CS/admin
  // tab fires the chime + toast the moment the lead is forwarded, with no
  // polling delay. This single page channel owns the CS banner, notification,
  // automatic rephrase, and CS query invalidation so those features do not
  // require a second qualified_leads subscription.
  const armedRef = useRef(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported",
  );
  const [incomingLead, setIncomingLead] = useState<{
    name: string;
    area: string | null;
    context: string | null;
    at: number;
  } | null>(null);

  useEffect(() => {
    // Arm after first paint so we don't beep for historical rows during
    // initial subscription replay.
    const t = setTimeout(() => {
      armedRef.current = true;
    }, 1500);
    const channel = supabase.channel(`cs-leads-new-ping-${crypto.randomUUID()}`);
    (channel as unknown as { on: (...args: unknown[]) => typeof channel }).on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "qualified_leads" },
      (payload: {
        new: {
          id?: string;
          customer_name?: string;
          main_area?: string | null;
          sub_area?: string | null;
          context?: string | null;
          marketing_notes?: string | null;
        };
      }) => {
        if (!armedRef.current) return;
        setNewLeadCount((current) => current + 1);
        const name = payload.new?.customer_name ?? "incoming";
        const area = payload.new?.main_area || payload.new?.sub_area || null;
        playNotificationBeep();
        showBrowserNotification("New lead forwarded to CS", area ? `${name} — ${area}` : name);
        toast.success(`New lead: ${name}`, { duration: 8000 });
        setIncomingLead({
          name,
          area,
          context: payload.new?.context ?? null,
          at: Date.now(),
        });

        // Auto-rephrase new lead if toggle is enabled and marketing_notes is not yet set
        if (autoRephraseEnabledRef.current && payload.new?.id && !payload.new?.marketing_notes) {
          const inserted = payload.new as Record<string, unknown>;
          void autoRephraseLeadWithAi({ data: { leadId: payload.new.id } })
            .then((res) => {
              if (!res?.success) return;
              qc.invalidateQueries({ queryKey: ["cs_leads"] });
              // This write happens on the server, so it is the one lead change
              // with no acting client to mirror it to Google Sheets. Every
              // other path syncs from its own write; the realtime handler no
              // longer does it for everyone.
              void syncLeadToGoogleSheet("UPDATE", {
                ...(inserted as unknown as Parameters<typeof syncLeadToGoogleSheet>[1]),
                marketing_notes: res.rephrased ?? null,
              });
            })
            .catch(() => {});
        }

        qc.invalidateQueries({ queryKey: ["cs_leads"] });
      },
    );
    // NOTE: qualified_leads UPDATE events are handled globally by
    // useRealtimeSync (which invalidates ["cs_leads"]). We intentionally do
    // NOT re-subscribe to UPDATE here — a second binding would double the
    // Realtime-message billing for every CS user on this page.
    channel.subscribe();
    return () => {
      clearTimeout(t);
      supabase.removeChannel(channel);
    };
    // `qc` is the context QueryClient singleton — its identity is stable for the
    // app lifetime, so listing it does not re-run this mount-once subscription.
  }, [qc]);

  useEffect(() => {
    if (!incomingLead) return;
    const t = setTimeout(() => setIncomingLead(null), 5000);
    return () => clearTimeout(t);
  }, [incomingLead]);

  const enableAlerts = async () => {
    try {
      if (!("Notification" in window)) {
        toast.error("This browser does not support notifications");
        return;
      }
      const perm = await Notification.requestPermission();
      setNotifPermission(perm);
      // Play a short test tone — this also unlocks the AudioContext so
      // future real-time alerts can play without a user gesture.
      playNotificationBeep();
      if (perm === "granted") {
        showBrowserNotification("Alerts enabled", "You'll be pinged for new CS leads.");
        toast.success("Alerts enabled — you'll hear and see new leads.");
      } else {
        toast.message("Sound enabled. Allow notifications in the browser for pop-ups.");
      }
    } catch {
      toast.error("Could not enable alerts");
    }
  };

  // Note: activeStatus state is defined above the DB query memos so that
  // dbStatus can reference it. The `filtered` memo below only handles
  // client-side refinements (search text and area) on the current page's
  // 50-row result. Date / owner / status filters are already applied by DB.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data ?? []).filter((l) => {
      // Full text search — applied client-side on the 50-row page result.
      // Searches all the same fields as before: name, phone, area, requirements.
      if (q) {
        const textMatch = [
          l.customer_name,
          l.customer_number,
          l.customer_number_2,
          l.number_name,
          l.main_area,
          l.sub_area,
          l.pass_it_to,
          l.requirement_1,
          l.requirement_2,
        ].some((f) => f?.toLowerCase().includes(q));
        // Match phone numbers by digits so formatting differences don't hide
        // rows the DB query already matched (e.g. "5551234567" vs "(555) 123-4567").
        const phoneMatch =
          phoneDigitsMatch(l.customer_number, q) || phoneDigitsMatch(l.customer_number_2, q);
        if (!textMatch && !phoneMatch) {
          return false;
        }
      }
      // Area filter — main_area is unindexed so kept client-side on current page.
      if (areaFilter !== "all" && l.main_area !== areaFilter && l.sub_area !== areaFilter) {
        return false;
      }
      return true;
    });
  }, [areaFilter, list.data, query]);

  const counts = allTimeStatusCounts.data?.statuses ?? {};
  const allLeadsCount = allTimeStatusCounts.data?.all ?? 0;

  // All leads on the current page after client-side filtering, sorted with
  // pinned-important leads first (DB also orders pinned first, so this is
  // a stable secondary sort for any ties within the 50-row page).
  const visibleLeads = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aPinned = a.pinned_important && a.cs_status === "new";
      const bPinned = b.pinned_important && b.cs_status === "new";
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return new Date(b.assigned_at).getTime() - new Date(a.assigned_at).getTime();
    });
  }, [filtered]);
  // shownLeads = all leads on current page (no slicing needed — DB paginates).
  const shownLeads = visibleLeads;

  function exportLeads() {
    downloadCsv(
      "cs-leads.csv",
      [
        "Customer",
        "Phone",
        "Second Phone",
        "Number Name",
        "Requirement 1",
        "Requirement 2",
        "Status",
        "Delivery",
        "Called At (ET)",
        "Assigned To",
        "Area",
        "Sub Area",
        "Created (ET)",
      ],
      visibleLeads.map((lead) => [
        lead.customer_name,
        formatPhone(lead.customer_number),
        formatPhone(lead.customer_number_2),
        lead.number_name ?? "",
        lead.requirement_1 ?? "",
        lead.requirement_2 ?? "",
        STATUS_LABEL[lead.cs_status] ?? lead.cs_status,
        lead.contact_method === "called" ? "Called" : "Texted",
        lead.called_at ? formatCsPipelineDateTime(lead.called_at) : "",
        lead.assigned_to
          ? (teamById.get(lead.assigned_to)?.full_name ??
            teamById.get(lead.assigned_to)?.email ??
            "")
          : "Unassigned",
        lead.main_area ?? "",
        lead.sub_area ?? "",
        formatCsPipelineDateTime(lead.assigned_at),
      ]),
    );
    toast.success(`Exported ${visibleLeads.length} CS lead${visibleLeads.length === 1 ? "" : "s"}`);
  }

  return (
    <div className="space-y-4">
      {newLeadCount > 0 && (
        <button
          onClick={() => {
            qc.invalidateQueries({ queryKey: ["cs_leads"] });
            clearAlert();
          }}
          className="crm-motion w-full text-[13px] bg-primary/10 border border-primary/20 text-primary py-2.5 px-4 rounded-xl flex items-center justify-between hover:bg-primary/15 animate-pulse duration-[2000ms]"
        >
          <span className="font-semibold text-left">
            🔔 New lead{newLeadCount === 1 ? "" : "s"} available — click to refresh
          </span>
          <span className="text-xs bg-primary/20 px-2 py-0.5 rounded-full shrink-0 ml-2">
            {newLeadCount} new
          </span>
        </button>
      )}
      <div className="crm-toolbar-panel">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customer, area, phone…"
              className="w-full h-9 pl-9 pr-3 rounded-md bg-surface border border-border text-[13px] placeholder:text-muted-foreground/70 focus:outline-none"
            />
          </div>
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="h-9 w-[150px] text-[12px]">
              <SelectValue placeholder="Owner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              <SelectItem value="mine">My leads</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {team.data?.map((member) => (
                <SelectItem key={member.user_id} value={member.user_id}>
                  {member.full_name || member.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={areaFilter} onValueChange={setAreaFilter}>
            <SelectTrigger className="h-9 w-[150px] text-[12px]">
              <SelectValue placeholder="Area" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All areas</SelectItem>
              {areaOptions.map((area) => (
                <SelectItem key={area} value={area}>
                  {area}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant={garageDoorOnly ? "default" : "outline"}
            className="h-9 text-[12px]"
            onClick={() => setGarageDoorOnly((v) => !v)}
            title={
              garageDoorOnly
                ? "Showing garage door leads only — click to clear"
                : "Show only garage door leads"
            }
          >
            <Warehouse className="h-3.5 w-3.5 mr-1.5" />
            Garage Door
            {garageDoorOnly && (
              <span className="ml-1.5 tabular-nums opacity-90">
                ({garageDoorCount.isLoading ? "—" : (garageDoorCount.data ?? 0)})
              </span>
            )}
          </Button>
          {(isAdmin || isCs) && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 text-[12px]">
                  <CalendarDays className="h-3.5 w-3.5 mr-1.5" />
                  {dateRange?.from
                    ? dateRange.to
                      ? `${formatCsPipelineCalendarShortDate(dateRange.from)} – ${formatCsPipelineCalendarShortDate(dateRange.to)}`
                      : formatCsPipelineCalendarDateWithYear(dateRange.from)
                    : "Date range"}
                  {dateRange?.from && (
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveDatePreset(null);
                        setDateRange(undefined);
                      }}
                      className="ml-1.5 -mr-1 h-4 w-4 grid place-items-center rounded-full hover:bg-destructive/20"
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div className="flex items-center justify-end p-2 border-b border-border">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      setActiveDatePreset(null);
                      setDateRange(undefined);
                    }}
                  >
                    Clear
                  </Button>
                </div>
                <Calendar
                  mode="range"
                  selected={dateRange}
                  onSelect={(range) => {
                    setActiveDatePreset(null);
                    setDateRange(range);
                  }}
                  numberOfMonths={2}
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
          )}
          {(isAdmin || isCs) &&
            (() => {
              return (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={activeDatePreset === "today" ? "default" : "outline"}
                    className="h-9 text-[12px] px-2.5"
                    onClick={() => applyDatePreset("today")}
                  >
                    Today
                  </Button>
                  <Button
                    size="sm"
                    variant={activeDatePreset === "last7" ? "default" : "outline"}
                    className="h-9 text-[12px] px-2.5"
                    onClick={() => applyDatePreset("last7")}
                  >
                    7d
                  </Button>
                  <Button
                    size="sm"
                    variant={activeDatePreset === "last30" ? "default" : "outline"}
                    className="h-9 text-[12px] px-2.5"
                    onClick={() => applyDatePreset("last30")}
                  >
                    30d
                  </Button>
                </div>
              );
            })()}
          <div className="ml-auto flex items-center gap-2">
            <div
              className="px-3 h-9 inline-flex items-center gap-2 rounded-md bg-surface border border-border text-[12px] shadow-sm select-none"
              title={
                autoRephraseToggle.enabled
                  ? "Auto-rephrase is ON (New incoming leads will be auto-rephrased)"
                  : "Auto-rephrase is OFF (Only manual rephrasing)"
              }
            >
              <Sparkles
                className={cn(
                  "h-3.5 w-3.5",
                  autoRephraseToggle.enabled ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="text-foreground font-medium">Auto-rephrase</span>
              <Switch
                checked={autoRephraseToggle.enabled}
                onCheckedChange={async (checked) => {
                  try {
                    await autoRephraseToggle.setEnabled(checked);
                    toast.success(checked ? "Auto-rephrase turned ON" : "Auto-rephrase turned OFF");
                  } catch (err) {
                    toast.error(friendlyError(err));
                  }
                }}
                disabled={autoRephraseToggle.isLoading}
                aria-label="Toggle Auto-rephrase"
              />
            </div>
            <div className="px-3 h-9 inline-flex items-center gap-2 rounded-md bg-surface border border-border text-[12px] shadow-sm">
              <span className="text-muted-foreground">Sent today</span>
              <span className="font-semibold tabular-nums">{sentToday.data ?? "—"}</span>
            </div>
            <Button
              variant={notifPermission === "granted" ? "outline" : "default"}
              size="sm"
              className="h-9"
              onClick={enableAlerts}
              title={
                notifPermission === "granted"
                  ? "Alerts on — click to test"
                  : notifPermission === "denied"
                    ? "Notifications blocked in browser settings — click to enable sound"
                    : "Enable sound + pop-up alerts for new leads"
              }
            >
              {notifPermission === "granted" ? (
                <Bell className="h-3.5 w-3.5 mr-1.5" />
              ) : (
                <BellOff className="h-3.5 w-3.5 mr-1.5" />
              )}
              {notifPermission === "granted" ? "Alerts on" : "Enable alerts"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => qc.invalidateQueries({ queryKey: ["cs_leads"] })}
              disabled={list.isFetching}
            >
              {list.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Refresh
            </Button>
            {isAdmin && (
              <div className="inline-flex items-center gap-1.5 h-9 pl-2 pr-1 rounded-md bg-surface border border-border shadow-sm">
                <Sparkles className="h-3.5 w-3.5 text-warning" />
                <Select
                  value={importantAssignee}
                  onValueChange={(v) => {
                    setImportantAssignee(v);
                    setImportantConfirmOpen(true);
                  }}
                >
                  <SelectTrigger className="h-7 border-0 bg-transparent px-1.5 text-[12px] focus:ring-0 focus:ring-offset-0 shadow-none min-w-[190px]">
                    <SelectValue placeholder="Assign Important Leads" />
                  </SelectTrigger>
                  <SelectContent>
                    {(team.data ?? []).length === 0 ? (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground">
                        No active CS users
                      </div>
                    ) : (
                      (team.data ?? []).map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          <div className="flex flex-col">
                            <span className="text-[12px] font-medium">
                              {m.full_name || m.email}
                            </span>
                            {m.full_name && (
                              <span className="text-[10px] text-muted-foreground">{m.email}</span>
                            )}
                          </div>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}
            {auth.primaryRole === "admin" && (
              <Button variant="outline" size="sm" className="h-9" onClick={exportLeads}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export
              </Button>
            )}
          </div>
        </div>
      </div>

      <AlertDialog
        open={importantConfirmOpen}
        onOpenChange={(o) => {
          if (importantBusy) return;
          setImportantConfirmOpen(o);
          if (!o) setImportantAssignee("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Assign all important leads?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const m = teamById.get(importantAssignee);
                const name = m?.full_name || m?.email || "the selected CS user";
                const n = importantCount.data ?? 0;
                if (n === 0) return `No important leads are currently available to assign.`;
                return `${n} important lead${n === 1 ? "" : "s"} will be reassigned to ${name}. Non-important leads are unchanged.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importantBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={importantBusy || !importantAssignee || (importantCount.data ?? 0) === 0}
              onClick={(e) => {
                e.preventDefault();
                void confirmBulkAssignImportant();
              }}
            >
              {importantBusy ? "Assigning..." : "Assign Important Leads"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Status tabs */}
      <div className="crm-toolbar-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-border bg-card p-1 ">
            <button
              type="button"
              onClick={() => setActiveStatus("__all__")}
              className={cn(
                "crm-motion px-3 h-8 text-[12px] font-medium rounded-lg inline-flex items-center gap-1.5",
                activeStatus === "__all__"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:bg-surface hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  activeStatus === "__all__" ? "bg-card" : "bg-foreground",
                )}
              />
              All Leads
              <span
                className={cn(
                  "text-[10.5px] tabular-nums",
                  activeStatus === "__all__"
                    ? "text-primary-foreground/90"
                    : "text-muted-foreground",
                )}
              >
                {allLeadsCount}
              </span>
            </button>
            {PIPELINE_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setActiveStatus(s)}
                className={cn(
                  "crm-motion px-3 h-8 text-[12px] font-medium rounded-lg inline-flex items-center gap-1.5",
                  activeStatus === s
                    ? cn(
                        "shadow-sm ring-1",
                        STATUS_TONE[s] ?? "bg-surface-hover text-foreground border-border",
                      )
                    : "text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", statusDotTone(s))} />
                {STATUS_LABEL[s] ?? s}
                <span
                  className={cn(
                    "text-[10.5px] tabular-nums",
                    activeStatus === s ? "text-current/80" : "text-muted-foreground",
                  )}
                >
                  {counts[s] ?? 0}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setNotCalledOnly(false);
                setActiveStatus("templates");
              }}
              className={cn(
                "crm-motion px-3 h-8 text-[12px] font-medium rounded-lg inline-flex items-center gap-1.5",
                activeStatus === "templates"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:bg-surface hover:text-foreground",
              )}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Templates
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-2.5">
              <Phone
                className={cn(
                  "h-3.5 w-3.5",
                  notCalledOnly ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="text-[11px] font-semibold text-muted-foreground">Not called</span>
              <Select value={notCalledFilterValue} onValueChange={changeNotCalledFilter}>
                <SelectTrigger className="h-7 w-[170px] border-0 bg-transparent px-2 text-[12px] shadow-none focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__off__">Filter off</SelectItem>
                  <SelectItem value="__all__">All statuses</SelectItem>
                  {PIPELINE_STATUSES.map((statusOption) => (
                    <SelectItem key={statusOption} value={statusOption}>
                      {STATUS_LABEL[statusOption] ?? statusOption}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="inline-flex items-center gap-1 rounded-xl border border-border bg-surface p-1 ">
              <button
                type="button"
                onClick={() => {
                  setNotCalledOnly(false);
                  setViewMode("cards");
                }}
                className={cn(
                  "crm-motion h-8 px-3 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5",
                  viewMode === "cards"
                    ? "bg-surface-hover text-foreground ring-1 ring-border shadow-sm"
                    : "text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Cards
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={cn(
                  "crm-motion h-8 px-3 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5",
                  viewMode === "table"
                    ? "bg-surface-hover text-foreground ring-1 ring-border shadow-sm"
                    : "text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <Table2 className="h-3.5 w-3.5" />
                Table
              </button>
            </div>
          </div>
        </div>
      </div>

      {list.error && (
        <div className="text-[12.5px] text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {(list.error as Error).message}
        </div>
      )}

      {activeStatus === "templates" ? (
        <ComposeTemplatesManager userId={auth.user?.id} />
      ) : list.isLoading && !list.data ? (
        <div className="crm-section-panel">
          <div className="glass-card p-16 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading pipeline…
          </div>
        </div>
      ) : visibleLeads.length === 0 ? (
        <div className="crm-section-panel">
          <div className="glass-card p-10 text-center text-[12.5px] text-muted-foreground">
            <Search className="h-5 w-5 mx-auto mb-2 opacity-50" />
            {notCalledOnly
              ? "No leads in this status are waiting to be called."
              : "No leads yet. New leads will appear here when forwarded from the pipeline."}
          </div>
        </div>
      ) : (
        <div className="crm-section-panel space-y-4">
          {(isCs || isAdmin) && selectedIds.size > 0 && (
            <div className="sticky top-[96px] z-20 -mx-4 mb-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-card/92 px-4 py-2 text-[12px] shadow-md backdrop-blur supports-[backdrop-filter]:bg-card/86">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">{selectedIds.size} selected</span>
                <button
                  type="button"
                  onClick={() => {
                    const ids = new Set(shownLeads.map((l) => l.id));
                    setSelectedIds(ids);
                  }}
                  className="text-primary hover:underline"
                >
                  Select all visible
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              </div>
              {isAdmin ? (
                <div className="flex items-center gap-2">
                  <Select value={bulkAssignee} onValueChange={setBulkAssignee}>
                    <SelectTrigger className="h-8 w-[190px] text-[12px]">
                      <SelectValue placeholder="Assign selected to..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                      {team.data?.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.full_name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={selectedIds.size === 0 || bulkBusy || !bulkAssignee}
                    onClick={bulkAssignAsAdmin}
                  >
                    {bulkBusy ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Assign {selectedIds.size > 0 ? selectedIds.size : ""}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  className="h-8"
                  disabled={selectedIds.size === 0 || bulkBusy}
                  onClick={bulkAssignToMe}
                >
                  {bulkBusy ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Assign {selectedIds.size > 0 ? selectedIds.size : ""} to myself
                </Button>
              )}
            </div>
          )}
          {dueLeads.length > 0 && (
            <div className="glass-card crm-accent-amber p-4 rounded-xl space-y-3 mb-4 border-warning/40">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-warning flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-warning animate-pulse" />
                  Follow-ups due today
                </h3>
                <span className="text-xs font-medium bg-card/88 text-warning px-2.5 py-0.5 rounded-full border border-warning/40 shadow-sm">
                  {dueLeads.length} lead{dueLeads.length === 1 ? "" : "s"} need follow-up
                </span>
              </div>
              <div className="divide-y divide-border/40 max-h-48 overflow-y-auto pr-1">
                {dueLeads.map((lead) => (
                  <div
                    key={lead.id}
                    className="py-2.5 flex items-center justify-between gap-4 text-xs first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <span className="font-semibold text-foreground/90">{lead.customer_name}</span>
                      {lead.customer_number && (
                        <span className="text-muted-foreground ml-2">
                          ({formatPhone(lead.customer_number)})
                        </span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-3 text-[11px] border-primary/30 hover:bg-primary/10 text-primary"
                      onClick={() => {
                        const el = document.getElementById(`lead-${lead.id}`);
                        if (el) {
                          el.scrollIntoView({ behavior: "smooth", block: "center" });
                          el.classList.add("ring-2", "ring-primary");
                          setTimeout(() => {
                            el.classList.remove("ring-2", "ring-primary");
                          }, 2000);
                        } else {
                          setOpened(lead);
                        }
                      }}
                    >
                      View
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {viewMode === "cards" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {shownLeads.map((l) => (
                <LeadCard
                  key={l.id}
                  lead={l}
                  team={team.data ?? []}
                  teamById={teamById}
                  onOpen={() => setOpened(l)}
                  templates={composeTemplatesList.templates}
                  selected={selectedIds.has(l.id)}
                  onToggleSelect={() => toggleSelect(l.id)}
                  showSelect={isCs || isAdmin}
                  profilesById={profilesById}
                />
              ))}
            </div>
          ) : (
            <CsLeadsTable leads={shownLeads} teamById={teamById} onOpen={setOpened} />
          )}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-2">
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
            <span className="ml-1 text-[11px]">({effectiveTotalCount} total)</span>
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

      {opened && (
        <LeadDrawer
          lead={opened}
          team={team.data ?? []}
          teamById={teamById}
          templates={composeTemplatesList.templates}
          onClose={() => {
            setOpened(null);
            clearDeepLink();
          }}
          onSaved={() => {
            setOpened(null);
            clearDeepLink();
            qc.invalidateQueries({ queryKey: ["cs_leads"] });
          }}
          profilesById={profilesById}
        />
      )}

      {incomingLead && (
        <div className="fixed bottom-4 right-4 z-50 w-[min(calc(100vw-2rem),360px)] rounded-lg border border-border bg-card shadow-lg animate-fade-in-up">
          <div className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-semibold text-[14px]">
                  <Bell className="h-4 w-4 text-primary shrink-0" />
                  <span>New lead forwarded to CS</span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  A new qualified lead just landed in your pipeline.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIncomingLead(null)}
                className="text-muted-foreground hover:text-foreground"
                title="Dismiss"
              >
                <span className="sr-only">Dismiss</span>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 space-y-1.5 text-[12.5px]">
              <div>
                <div className="text-muted-foreground text-[11px]">Customer</div>
                <div className="font-semibold truncate">{incomingLead.name}</div>
              </div>
              {incomingLead.area && (
                <div>
                  <div className="text-muted-foreground text-[11px]">Area</div>
                  <div className="truncate">{incomingLead.area}</div>
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => setIncomingLead(null)}
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                className="h-8"
                onClick={() => {
                  setActiveStatus("new");
                  qc.invalidateQueries({ queryKey: ["cs_leads"] });
                  setIncomingLead(null);
                }}
              >
                View
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CsLeadsTable({
  leads,
  teamById,
  onOpen,
}: {
  leads: Lead[];
  teamById: Map<string, CsTeamMember>;
  onOpen: (lead: Lead) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[12.5px]">
        <thead className="bg-surface text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Customer</th>
            <th className="text-left px-3 py-2 font-medium">Phone</th>
            <th className="text-left px-3 py-2 font-medium">Second Phone</th>
            <th className="text-left px-3 py-2 font-medium">Number Name</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
            <th className="text-left px-3 py-2 font-medium">Delivery</th>
            <th className="text-left px-3 py-2 font-medium">Called at</th>
            <th className="text-left px-3 py-2 font-medium">Assigned</th>
            <th className="text-left px-3 py-2 font-medium">Area</th>
            <th className="text-left px-3 py-2 font-medium">Compose</th>
            <th className="text-left px-3 py-2 font-medium">Forwarded</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const assignee = lead.assigned_to ? teamById.get(lead.assigned_to) : null;
            return (
              <tr
                id={`lead-${lead.id}`}
                key={lead.id}
                className="crm-data-row border-t border-border cursor-pointer"
                onClick={() => onOpen(lead)}
              >
                <td className="px-3 py-2 font-medium">
                  <div className="flex items-center gap-1.5">
                    {lead.is_important &&
                      (lead.pinned_important && lead.cs_status === "new" ? (
                        <Pin
                          aria-label="Pinned Important"
                          className="h-3.5 w-3.5 text-warning fill-warning/20 rotate-45 shrink-0"
                        />
                      ) : (
                        <Sparkles
                          aria-label="Important"
                          className="h-3.5 w-3.5 text-warning fill-warning/20 shrink-0"
                        />
                      ))}
                    <span>{lead.customer_name}</span>
                    {lead.out_of_base && (
                      <span className="inline-flex items-center rounded-full bg-[#fde8d5] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#b4530a] ring-1 ring-[#f4c79a]">
                        Out of Base
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  <div className="inline-flex items-center gap-1.5 flex-wrap">
                    <PhoneCopyLink phone={lead.customer_number} compact />
                    {lead.is_landline && (
                      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-amber-500/30 dark:text-amber-300">
                        Landline
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {lead.customer_number_2 ? (
                    <PhoneCopyLink phone={lead.customer_number_2} compact />
                  ) : (
                    "-"
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{lead.number_name || "-"}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={lead.cs_status} />
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold",
                      lead.contact_method === "called"
                        ? "border-primary/25 bg-primary/10 text-primary"
                        : "border-border bg-surface text-muted-foreground",
                    )}
                  >
                    {lead.contact_method === "called" ? (
                      <Phone className="h-3 w-3" />
                    ) : (
                      <MessageSquareText className="h-3 w-3" />
                    )}
                    {lead.contact_method === "called" ? "Called" : "Texted"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground tabular-nums">
                  {lead.called_at ? formatCsPipelineDateTime(lead.called_at) : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {assignee ? assignee.full_name || assignee.email : "Unassigned"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{lead.sub_area || "-"}</td>
                <td className="px-3 py-2 text-muted-foreground max-w-[260px]">
                  <div className="truncate">{lead.marketing_notes || "-"}</div>
                </td>
                <td className="px-3 py-2 text-muted-foreground tabular-nums">
                  {formatDistanceToNow(new Date(lead.assigned_at), { addSuffix: true })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LeadCard({
  lead,
  team,
  teamById,
  onOpen,
  templates = [],
  selected = false,
  onToggleSelect,
  showSelect = false,
  profilesById,
}: {
  lead: Lead;
  team: CsTeamMember[];
  teamById: Map<string, CsTeamMember>;
  onOpen: () => void;
  templates?: ComposeTemplateItem[];
  selected?: boolean;
  onToggleSelect?: () => void;
  showSelect?: boolean;
  profilesById?: Map<string, { full_name: string | null; email: string }>;
}) {
  const qc = useQueryClient();
  const auth = useAuth();
  const [status, setStatus] = useState<CsStatus>(lead.cs_status);
  const [contactMethod, setContactMethodState] = useState<ContactMethod>(
    lead.contact_method ?? "texted",
  );
  const [calledAt, setCalledAt] = useState<string | null>(lead.called_at);
  const [savingContactMethod, setSavingContactMethod] = useState(false);
  const [assignedTo, setAssignedTo] = useState<string | null>(lead.assigned_to);
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [numberName, setNumberName] = useState(lead.number_name ?? "");
  const [compose, setCompose] = useState(lead.marketing_notes ?? "");
  const [requirement1, setRequirement1] = useState(lead.requirement_1 ?? "");
  const [requirement2, setRequirement2] = useState(lead.requirement_2 ?? "");
  const [important, setImportant] = useState(lead.is_important);
  const [savingImportant, setSavingImportant] = useState(false);
  const initials = "";
  const isAdmin = auth.primaryRole === "admin" || auth.primaryRole === "cs_admin";
  const isCs = auth.primaryRole === "cs";
  // Role visibility for source/forwarder metadata (admin only) and
  // conversation attachments (admin + cs_admin).
  const canViewForwardMeta = auth.primaryRole === "admin";
  const canViewAttachments = auth.primaryRole === "admin" || auth.primaryRole === "cs_admin";
  const assignee = assignedTo ? teamById.get(assignedTo) : null;
  const assignedToMe = !!assignedTo && assignedTo === auth.user?.id;
  const creator = lead.created_by ? profilesById?.get(lead.created_by) : null;
  const forwardedByText = creator
    ? creator.full_name || creator.email
    : lead.created_by
      ? "Unknown user"
      : null;
  const serviceLabel = formatLeadServiceLabel(lead.service);

  const [rephrasing, setRephrasing] = useState(false);
  const rephraseFn = useServerFn(rephraseLeadTemplateWithAi);

  async function handleRephrase(e: React.MouseEvent) {
    e.stopPropagation();
    if (!lead.context && !lead.post_text) return;
    setRephrasing(true);
    try {
      const result = await rephraseFn({
        data: {
          leadId: lead.id,
        },
      });
      if (result?.rephrased) {
        setCompose(result.rephrased);
        await saveField({ marketing_notes: result.rephrased } as Partial<Lead>);
        qc.invalidateQueries({ queryKey: ["cs_leads"] });
        toast.success("Rephrased template with AI");
      } else {
        toast.error("AI did not return a rephrased message");
      }
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setRephrasing(false);
    }
  }

  const finalTemplates =
    Array.isArray(templates) && templates.length > 0 ? templates : DEFAULT_COMPOSE_TEMPLATES;
  const composeSuggestion = finalTemplates[0]
    ? renderCsComposeSuggestion(finalTemplates[0].template, lead)
    : "";

  async function saveField(patch: Partial<Lead>) {
    const { error } = await supabase
      .from("qualified_leads")
      .update(patch as never)
      .eq("id", lead.id);
    if (error) {
      toast.error(friendlyError(error));
      return false;
    }
    void syncLeadToGoogleSheet("UPDATE", { ...lead, ...patch });
    return true;
  }

  function requestStatusChange(next: CsStatus) {
    if (next !== status) void changeStatus(next);
  }

  // Delivery method (Texted / Called) lives on the lead itself, defaulting to
  // Texted. It is toggled directly from the card rather than prompted on every
  // status change, and travels with the lead into the forwarded-leads view.
  async function changeContactMethod(method: ContactMethod) {
    if (method === contactMethod) return;
    const prev = contactMethod;
    const previousCalledAt = calledAt;
    const nextCalledAt = method === "called" ? new Date().toISOString() : null;
    setContactMethodState(method);
    setCalledAt(nextCalledAt);
    setSavingContactMethod(true);
    try {
      const { error } = await supabase
        .from("qualified_leads")
        .update({ contact_method: method, called_at: nextCalledAt })
        .eq("id", lead.id);
      if (error) throw error;
      await supabase.from("activity_logs").insert({
        actor_id: auth.user?.id,
        actor_name: auth.profile?.full_name,
        actor_role: auth.primaryRole,
        action: "cs.contact_method_changed",
        entity_type: "qualified_lead",
        entity_id: lead.id,
        metadata: {
          contact_method: method,
          previous_contact_method: prev,
          called_at: nextCalledAt,
          from: "card",
        },
      });
      void syncLeadToGoogleSheet("UPDATE", {
        ...lead,
        contact_method: method,
        called_at: nextCalledAt,
      });
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
    } catch (e) {
      setContactMethodState(prev);
      setCalledAt(previousCalledAt);
      toast.error(friendlyError(e));
    } finally {
      setSavingContactMethod(false);
    }
  }

  async function changeStatus(next: CsStatus) {
    const prev = status;
    setStatus(next);
    setSaving(true);
    try {
      const { error } = await supabase
        .from("qualified_leads")
        .update({ cs_status: next })
        .eq("id", lead.id);
      if (error) throw error;
      await supabase.from("activity_logs").insert({
        actor_id: auth.user?.id,
        actor_name: auth.profile?.full_name,
        actor_role: auth.primaryRole,
        action: "cs.status_changed",
        entity_type: "qualified_lead",
        entity_id: lead.id,
        metadata: {
          status: next,
          previous_status: prev,
          contact_method: contactMethod,
          from: "card",
        },
      });
      void syncLeadToGoogleSheet("UPDATE", {
        ...lead,
        cs_status: next,
        contact_method: contactMethod,
        pinned_important: pinnedImportantFor(lead.pinned_important, next),
      });
      toast.success(`Status → ${STATUS_LABEL[next] ?? next}`);
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
    } catch (e) {
      setStatus(prev);
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  async function changeAssignee(nextValue: string) {
    const next = nextValue === UNASSIGNED_VALUE ? null : nextValue;
    const prev = assignedTo;
    setAssignedTo(next);
    setAssigning(true);
    try {
      const { error } = await supabase
        .from("qualified_leads")
        .update({
          assigned_to: next,
          assigned_by: next
            ? lead.assigned_to === next
              ? lead.assigned_by
              : auth.user?.id || null
            : null,
        } as never)
        .eq("id", lead.id);
      if (error) throw error;
      const nextName = next ? (teamById.get(next)?.full_name ?? "teammate") : "unassigned";
      await supabase.from("activity_logs").insert({
        actor_id: auth.user?.id,
        actor_name: auth.profile?.full_name,
        actor_role: auth.primaryRole,
        action: "cs.assigned",
        entity_type: "qualified_lead",
        entity_id: lead.id,
        metadata: { assigned_to: next, assigned_to_name: nextName },
      });
      void syncLeadToGoogleSheet("UPDATE", {
        ...lead,
        assigned_to: next,
        assigned_to_name: nextName,
      });
      toast.success(next ? `Assigned to ${nextName}` : "Unassigned");
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
    } catch (e) {
      setAssignedTo(prev);
      toast.error(friendlyError(e));
    } finally {
      setAssigning(false);
    }
  }

  async function assignToMe(e: React.MouseEvent) {
    e.stopPropagation();
    if (!auth.user?.id) return;
    await changeAssignee(auth.user.id);
  }

  async function toggleImportant(e: React.MouseEvent) {
    e.stopPropagation();
    if ((!isAdmin && !isCs) || lead.pinned_important) return;
    const next = !important;
    setImportant(next);
    setSavingImportant(true);
    try {
      const { error } = await supabase
        .from("qualified_leads")
        .update({ is_important: next })
        .eq("id", lead.id);
      if (error) throw error;
      await supabase.from("activity_logs").insert({
        actor_id: auth.user?.id,
        actor_name: auth.profile?.full_name,
        actor_role: auth.primaryRole,
        action: next ? "cs.marked_important" : "cs.unmarked_important",
        entity_type: "qualified_lead",
        entity_id: lead.id,
        metadata: { customer_name: lead.customer_name, pinned: false },
      });
      void syncLeadToGoogleSheet("UPDATE", { ...lead, is_important: next });
      toast.success(next ? "Lead marked important" : "Important tag removed");
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
    } catch (error) {
      setImportant(!next);
      toast.error(friendlyError(error));
    } finally {
      setSavingImportant(false);
    }
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  async function performDelete() {
    try {
      const { error } = await supabase.from("qualified_leads").delete().eq("id", lead.id);
      if (error) throw error;
      void syncLeadToGoogleSheet("DELETE", lead);
      await supabase.from("activity_logs").insert({
        actor_id: auth.user?.id,
        actor_name: auth.profile?.full_name,
        actor_role: auth.primaryRole,
        action: "cs.deleted",
        entity_type: "qualified_lead",
        entity_id: lead.id,
        metadata: { customer_name: lead.customer_name },
      });
      toast.success("Lead deleted");
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
    } catch (err) {
      toast.error(friendlyError(err));
    }
  }

  function deleteLead(e: React.MouseEvent) {
    e.stopPropagation();
    if (!isAdmin) return;
    setShowDeleteConfirm(true);
  }

  const imagesList = Array.isArray(lead.images) ? (lead.images as string[]) : [];
  let videoCount = 0;
  let imageCount = 0;
  imagesList.forEach((url) => {
    if (/\.(mp4|webm|mov)(\?.*)?$/i.test(url)) {
      videoCount++;
    } else {
      imageCount++;
    }
  });

  let attachmentText = "";
  if (videoCount > 0 && imageCount > 0) {
    attachmentText = "Pictures and videos attached";
  } else if (videoCount > 0) {
    attachmentText = "Videos attached";
  } else if (imageCount > 0) {
    attachmentText = "Pictures attached";
  }

  return (
    <div
      id={`lead-${lead.id}`}
      className={cn(
        "crm-lead-card crm-motion-lift crm-enter relative overflow-hidden p-4.5 group hover:border-border-strong hover:-translate-y-0.5 cursor-pointer bg-card",
        selected && "ring-2 ring-primary border-primary",
      )}
      onClick={onOpen}
    >
      {(important ||
        (canViewAttachments && Array.isArray(lead.images) && lead.images.length > 0)) && (
        <div className="flex flex-wrap gap-2 mb-3.5">
          {important && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-warning/10 text-warning border border-warning/40 crm-pill-text shadow-sm">
              {lead.pinned_important && lead.cs_status === "new" ? (
                <Pin className="h-3 w-3 fill-warning/20 rotate-45" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
              )}
              {lead.pinned_important && lead.cs_status === "new"
                ? "Pinned Important"
                : "Important job"}
            </div>
          )}
          {canViewAttachments && Array.isArray(lead.images) && lead.images.length > 0 && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary border border-primary/30 crm-pill-text shadow-sm">
              <Paperclip className="h-3 w-3 shrink-0" />
              <span>Pictures Attached</span>
            </div>
          )}
        </div>
      )}
      <div className="flex items-start gap-3.5">
        {showSelect && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="mt-1.5 h-4 w-4 accent-primary cursor-pointer"
            title="Select for bulk assignment"
          />
        )}
        <div className="hidden">{initials || "·"}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 className="crm-lead-title truncate">{lead.customer_name}</h3>
              <button
                type="button"
                title="Copy name"
                onClick={(e) => {
                  e.stopPropagation();
                  copyToClipboard(lead.customer_name, "Name copied");
                }}
                className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label="Copy name"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <StatusBadge status={status} />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
                className="inline-flex h-7 items-center rounded-lg border border-border px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={`Open lead details for ${lead.customer_name}`}
              >
                Open
              </button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {lead.out_of_base && (
              <span className="inline-flex items-center rounded-full bg-[#fde8d5] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#b4530a] ring-1 ring-[#f4c79a]">
                Out of Base
              </span>
            )}
            <PhoneCopyLink phone={lead.customer_number} compact />
            {lead.is_landline && (
              <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-amber-500/30 dark:text-amber-300">
                Landline
              </span>
            )}
          </div>
          {lead.customer_number_2 && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              <PhoneCopyLink phone={lead.customer_number_2} compact />
            </div>
          )}
        </div>
      </div>

      {lead.sub_area && (
        <div className="mt-3.5 flex items-center gap-2 crm-lead-meta">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[12.5px] font-semibold text-foreground ring-1 ring-primary/20">
            <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="truncate max-w-[220px]">{lead.sub_area}</span>
          </span>
          <button
            type="button"
            title="Copy area"
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard(lead.sub_area!, "Area copied");
            }}
            className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Copy area"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      )}

      {serviceLabel && (
        <div className="mt-2.5 flex items-center gap-2 crm-lead-meta">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-accent/60 px-2.5 py-1 text-[13px] font-semibold text-foreground ring-1 ring-border/70">
            <ArrowRightCircle className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="truncate max-w-[240px]">{serviceLabel}</span>
          </span>
        </div>
      )}

      <div className="mt-2.5 flex items-start gap-1.5 crm-lead-meta">
        <div className="min-w-0">
          <span className="crm-muted-text">Reference:</span>{" "}
          <span className="font-semibold text-foreground">{lead.reference || "-"}</span>
        </div>
      </div>

      {lead.context && (
        <div className="mt-4 rounded-2xl border border-border/70 bg-surface/72 px-3.5 py-3 ">
          <div className="crm-lead-label mb-1.5">Context</div>
          <p className="crm-lead-body line-clamp-3 whitespace-pre-wrap text-muted-foreground">
            {lead.context}
          </p>
        </div>
      )}

      {lead.post_text && (
        <div className="mt-3 rounded-2xl border border-border/70 bg-surface/68 px-3.5 py-3 ">
          <div className="crm-lead-label mb-1.5">Exact customer requirement</div>
          <p className="crm-lead-body line-clamp-3 whitespace-pre-wrap">{lead.post_text}</p>
        </div>
      )}

      {((canViewForwardMeta && lead.submitted_by_role) ||
        (canViewAttachments && attachmentText)) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {canViewForwardMeta && lead.submitted_by_role && (
            <span className="px-2.5 py-1 rounded-full bg-accent/45 text-accent-foreground border border-border crm-pill-text uppercase tracking-[0.08em]">
              via {lead.submitted_by_role}
            </span>
          )}
          {canViewAttachments && attachmentText && (
            <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 crm-pill-text uppercase tracking-[0.08em]">
              {attachmentText}
            </span>
          )}
        </div>
      )}

      {canViewForwardMeta && forwardedByText && (
        <div className="mt-3.5 flex items-center gap-1.5 text-[11.5px] crm-muted-text">
          <span className="crm-lead-label !text-[10px] !tracking-[0.08em] !font-bold !text-muted-foreground">
            Forwarded by
          </span>
          <span className="font-semibold text-foreground">{forwardedByText}</span>
        </div>
      )}

      <div className="mt-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <StatusPicker
          value={status}
          onChange={requestStatusChange}
          disabled={saving || (!isAdmin && !isCs && (!assignedTo || auth.user?.id !== assignedTo))}
          saving={saving}
        />
        <ContactMethodToggle
          value={contactMethod}
          calledAt={calledAt}
          onChange={changeContactMethod}
          disabled={
            savingContactMethod ||
            (!isAdmin && !isCs && (!assignedTo || auth.user?.id !== assignedTo))
          }
          saving={savingContactMethod}
        />
      </div>

      {/* Manual field filled by CS */}
      <div
        className="mt-4 rounded-2xl border border-border/70 bg-surface/70 px-3.5 py-3.5"
        onClick={(e) => e.stopPropagation()}
      >
        <Label className="crm-lead-label">Number Name</Label>
        <NumberNameSelect
          value={numberName}
          size="sm"
          className="mt-1.5"
          onChange={(v) => setNumberName(v)}
          onCommit={async (v) => {
            if (v !== (lead.number_name ?? "")) {
              // Empty selection ("No number name") clears the field to null.
              if (await saveField({ number_name: v.trim() || null } as Partial<Lead>)) {
                qc.invalidateQueries({ queryKey: ["cs_leads"] });
              }
            }
          }}
        />
      </div>

      <div
        className="mt-3 rounded-2xl border border-border/70 bg-surface/72 px-3.5 py-3.5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <Label className="crm-lead-label">Compose</Label>
          <div className="flex items-center gap-1.5">
            <Select
              onValueChange={async (val) => {
                const selectedTpl = finalTemplates.find((t) => t.id === val);
                if (selectedTpl) {
                  const generated = renderCsComposeSuggestion(selectedTpl.template, lead);
                  setCompose(generated);
                  await saveField({ marketing_notes: generated } as Partial<Lead>);
                  qc.invalidateQueries({ queryKey: ["cs_leads"] });
                }
              }}
            >
              <SelectTrigger className="h-6 w-[120px] text-[10px] py-0 px-2 bg-muted/40 border-dashed">
                <SelectValue placeholder="Use template..." />
              </SelectTrigger>
              <SelectContent>
                {finalTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-[11px]">
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(lead.context || lead.post_text) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRephrase}
                disabled={rephrasing}
                className="h-6 px-2 text-[10px] border-primary/40 text-primary hover:bg-primary/5 inline-flex items-center"
              >
                {rephrasing ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1 text-primary" />
                )}
                Rephrase
              </Button>
            )}
          </div>
        </div>
        <Textarea
          value={compose}
          rows={1}
          onChange={(e) => setCompose(e.target.value)}
          onBlur={async () => {
            if ((compose || "") !== (lead.marketing_notes ?? "")) {
              if (await saveField({ marketing_notes: compose } as Partial<Lead>)) {
                qc.invalidateQueries({ queryKey: ["cs_leads"] });
              }
            }
          }}
          className="text-[12.5px] mt-1.5 h-10 min-h-[40px] resize-none leading-relaxed py-2.5"
          placeholder="Compose a message or note for this lead…"
        />
        {composeSuggestion && (
          <ComposeSuggestion
            suggestion={composeSuggestion}
            compact
            onClick={async () => {
              setCompose(composeSuggestion);
              await saveField({ marketing_notes: composeSuggestion } as Partial<Lead>);
              qc.invalidateQueries({ queryKey: ["cs_leads"] });
            }}
          />
        )}
      </div>

      {/* Assignment row */}
      <div
        className="mt-3 rounded-2xl border border-border/65 bg-surface/68 px-3.5 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        {isAdmin ? (
          <Select
            value={assignedTo ?? UNASSIGNED_VALUE}
            onValueChange={changeAssignee}
            disabled={assigning}
          >
            <SelectTrigger className="h-9 text-[12.5px]">
              <div className="inline-flex items-center gap-1.5 truncate">
                <UserPlus className="h-3 w-3 text-muted-foreground" />
                <SelectValue placeholder="Assign to…" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
              {team.map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {m.full_name || m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center justify-between gap-2 text-[12.5px]">
            <span className="inline-flex items-center gap-1.5 crm-muted-text truncate">
              <UserCheck className="h-3 w-3" />
              {assignee ? (
                <span className={cn("truncate", assignedToMe && "text-primary font-medium")}>
                  {assignedToMe ? "You" : assignee.full_name || assignee.email}
                </span>
              ) : (
                <span className="italic text-muted-foreground/70">Unassigned</span>
              )}
            </span>
            {isCs && !assignedToMe && (
              <Button
                size="sm"
                variant={assignedTo ? "outline" : "default"}
                className="h-7 text-[11.5px] px-2"
                disabled={assigning}
                onClick={assignToMe}
              >
                {assigning ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <UserPlus className="h-3 w-3 mr-1" />
                )}
                {assignedTo ? "Take over" : "Assign to me"}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 pt-3.5 border-t border-border/60 flex items-center justify-between text-[11.5px] crm-muted-text">
        <span
          className="tabular-nums flex items-center gap-1.5"
          title={`Forwarded ${formatCsPipelineDateTime(lead.assigned_at)} ET`}
        >
          <span>{formatDistanceToNow(new Date(lead.assigned_at), { addSuffix: true })}</span>
          <span className="opacity-60">·</span>
          <span className="tabular-nums">{formatCsPipelineDateTime(lead.assigned_at)} ET</span>
        </span>
        {lead.followup_at && (
          <span className="inline-flex items-center gap-1 text-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Follow-up {formatDistanceToNow(new Date(lead.followup_at), { addSuffix: true })}
          </span>
        )}
        {isAdmin && (
          <>
            <button
              type="button"
              onClick={deleteLead}
              className="inline-flex items-center gap-1 text-destructive hover:text-destructive/80 transition-colors"
              title="Delete this lead"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
            <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
              <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete lead</AlertDialogTitle>
                  <AlertDialogDescription>
                    Delete lead for "{lead.customer_name}"? This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(false);
                    }}
                  >
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async (e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(false);
                      await performDelete();
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
        {(isAdmin || isCs) && (
          <button
            type="button"
            onClick={toggleImportant}
            disabled={savingImportant || lead.pinned_important}
            className={cn(
              "inline-flex items-center gap-1 transition-colors disabled:cursor-not-allowed",
              important ? "text-warning" : "hover:text-warning",
              lead.pinned_important && "opacity-60",
            )}
            title={
              lead.pinned_important
                ? "This lead was pinned as important before reaching CS"
                : important
                  ? "Remove important tag"
                  : "Mark as important without pinning"
            }
          >
            {savingImportant ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className={cn("h-3.5 w-3.5", important && "fill-warning/20")} />
            )}
            {lead.pinned_important
              ? "Pinned important"
              : important
                ? "Important"
                : "Mark important"}
          </button>
        )}
        <ArrowRight className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all text-primary" />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "crm-pill-text px-3 py-1.5 rounded-full border whitespace-nowrap shadow-sm",
        tone,
      )}
    >
      {STATUS_LABEL[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}

function statusDotTone(status: string) {
  if (status === "cx_interested") return "bg-success";
  if (status === "cx_not_interested") return "bg-destructive";
  if (status === "cx_didnt_replied") return "bg-warning";
  if (status === "converted" || status === "closed_won") return "bg-success";
  if (
    status === "need_follow_up" ||
    status === "follow_up" ||
    status === "called" ||
    status === "messaged"
  ) {
    return "bg-primary";
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
    return "bg-destructive";
  }
  if (
    status === "already_got_someone" ||
    status === "service_provider_himself" ||
    status === "small_service"
  ) {
    return "bg-muted-foreground";
  }
  return "bg-primary-glow";
}

function PhoneCopyLink({
  phone,
  compact = false,
}: {
  phone: string | null | undefined;
  compact?: boolean;
}) {
  if (!phone) return null;
  return (
    <div className={cn("inline-flex items-center gap-1.5", compact ? "crm-lead-meta" : "text-sm")}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void copyToClipboard(phone, "Phone number copied");
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/70 text-muted-foreground transition-colors hover:text-foreground hover:border-primary/50"
        title="Copy phone number"
        aria-label="Copy phone number"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <a
        href={`tel:${phone}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-primary"
      >
        <Phone className="h-3 w-3" />
        {formatPhone(phone)}
      </a>
    </div>
  );
}

function StatusPicker({
  value,
  disabled,
  saving,
  onChange,
}: {
  value: CsStatus;
  disabled?: boolean;
  saving?: boolean;
  onChange: (next: CsStatus) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PIPELINE_STATUSES.map((statusOption) => {
          const active = value === statusOption;
          return (
            <button
              key={statusOption}
              type="button"
              onClick={() => {
                if (!active) onChange(statusOption);
              }}
              disabled={disabled}
              className={cn(
                "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 crm-pill-text transition-colors",
                active
                  ? (STATUS_TONE[statusOption] ?? "bg-muted text-foreground border-border")
                  : "border-border bg-surface/70 text-muted-foreground hover:text-foreground hover:border-border/80",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full border text-[9px]",
                  active ? "border-current/50 bg-current/10" : "border-border bg-background",
                )}
              >
                {active ? <Check className="h-3 w-3" /> : null}
              </span>
              <span>{STATUS_LABEL[statusOption] ?? statusOption}</span>
            </button>
          );
        })}
      </div>
      {saving && (
        <div className="inline-flex items-center text-[11px] text-muted-foreground">
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          Updating status
        </div>
      )}
    </div>
  );
}

function ContactMethodToggle({
  value,
  calledAt,
  onChange,
  disabled,
  saving,
}: {
  value: ContactMethod;
  calledAt?: string | null;
  onChange: (method: ContactMethod) => void;
  disabled?: boolean;
  saving?: boolean;
}) {
  const options: { key: ContactMethod; label: string; icon: typeof Phone }[] = [
    { key: "texted", label: "Texted", icon: MessageSquareText },
    { key: "called", label: "Called", icon: Phone },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <div className="flex items-center gap-2">
        <span className="crm-lead-label !text-[10px] !tracking-[0.08em] !font-bold !text-muted-foreground">
          Delivery
        </span>
        <div className="inline-flex items-center gap-1 rounded-full border border-border bg-surface/70 p-0.5">
          {options.map((option) => {
            const active = value === option.key;
            const Icon = option.icon;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  if (!active && !disabled) onChange(option.key);
                }}
                disabled={disabled}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 crm-pill-text transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {value === "called" && calledAt && (
        <span className="text-[10.5px] text-muted-foreground tabular-nums">
          Called {formatCsPipelineDateTime(calledAt)}
        </span>
      )}
    </div>
  );
}

function LeadDrawer({
  lead,
  team,
  teamById,
  templates = [],
  onClose,
  onSaved,
  profilesById,
}: {
  lead: Lead;
  team: CsTeamMember[];
  teamById: Map<string, CsTeamMember>;
  templates?: ComposeTemplateItem[];
  onClose: () => void;
  onSaved: () => void;
  profilesById?: Map<string, { full_name: string | null; email: string }>;
}) {
  const auth = useAuth();
  const qc = useQueryClient();
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusDialog = window.requestAnimationFrame(() => dialogRef.current?.focus());
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        void confirmDiscardUnsaved(isDirtyRef.current).then((ok) => {
          if (ok) onClose();
        });
        return;
      }
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
        if (focusable.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(focusDialog);
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [status, setStatus] = useState<CsStatus>(lead.cs_status);
  const [contactMethod, setContactMethod] = useState<ContactMethod>(
    lead.contact_method ?? "texted",
  );
  const [calledAt, setCalledAt] = useState<string | null>(lead.called_at);
  const [assignedTo, setAssignedTo] = useState<string | null>(lead.assigned_to);
  const [note, setNote] = useState("");
  const [numberName, setNumberName] = useState(lead.number_name ?? "");
  const [compose, setCompose] = useState(lead.marketing_notes ?? "");
  const [requirement1, setRequirement1] = useState(lead.requirement_1 ?? "");
  const [requirement2, setRequirement2] = useState(lead.requirement_2 ?? "");
  const initialFollowup = useMemo(
    () => utcIsoToCsPipelineInputValue(lead.followup_at),
    [lead.followup_at],
  );
  const [followup, setFollowup] = useState(initialFollowup);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const notes = useMemo(() => (Array.isArray(lead.cs_notes) ? lead.cs_notes : []), [lead.cs_notes]);
  const isAdmin = auth.primaryRole === "admin" || auth.primaryRole === "cs_admin";
  const isCs = auth.primaryRole === "cs";
  const canViewForwardMeta = auth.primaryRole === "admin";
  const canViewAttachments = auth.primaryRole === "admin" || auth.primaryRole === "cs_admin";

  const [isImportant, setIsImportant] = useState(lead.is_important);
  const assignee = assignedTo ? teamById.get(assignedTo) : null;
  const assignedToMe = !!assignedTo && assignedTo === auth.user?.id;

  const isDirty =
    status !== lead.cs_status ||
    contactMethod !== (lead.contact_method ?? "texted") ||
    assignedTo !== lead.assigned_to ||
    note !== "" ||
    requirement1 !== (lead.requirement_1 ?? "") ||
    requirement2 !== (lead.requirement_2 ?? "") ||
    followup !== initialFollowup ||
    isImportant !== lead.is_important;
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  function handleClose() {
    void confirmDiscardUnsaved(isDirty).then((ok) => {
      if (ok) onClose();
    });
  }

  // Lock background body scroll when drawer is open
  useEffect(() => {
    const originalStyle = window.getComputedStyle(document.body).overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalStyle;
    };
  }, []);

  const creator = lead.created_by ? profilesById?.get(lead.created_by) : null;
  const forwardedByText = creator
    ? creator.full_name || creator.email
    : lead.created_by
      ? "Unknown user"
      : null;

  const [rephrasing, setRephrasing] = useState(false);
  const rephraseFn = useServerFn(rephraseLeadTemplateWithAi);

  async function handleRephrase() {
    if (!lead.context && !lead.post_text) return;
    setRephrasing(true);
    try {
      const result = await rephraseFn({
        data: {
          leadId: lead.id,
        },
      });
      if (result?.rephrased) {
        setCompose(result.rephrased);
        toast.success("Rephrased template with AI");
      } else {
        toast.error("AI did not return a rephrased message");
      }
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setRephrasing(false);
    }
  }

  const finalTemplates =
    Array.isArray(templates) && templates.length > 0 ? templates : DEFAULT_COMPOSE_TEMPLATES;
  const composeSuggestion = finalTemplates[0]
    ? renderCsComposeSuggestion(finalTemplates[0].template, lead)
    : "";

  function requestStatusChange(next: CsStatus) {
    if (next !== status) setStatus(next);
  }

  function changeDrawerContactMethod(method: ContactMethod) {
    setContactMethod(method);
    setCalledAt(method === "called" ? (lead.called_at ?? new Date().toISOString()) : null);
  }

  async function save() {
    setBusy(true);
    try {
      const newNotes = note.trim()
        ? [
            ...notes,
            {
              at: new Date().toISOString(),
              by: auth.profile?.full_name ?? auth.user?.email ?? "user",
              text: note.trim(),
            },
          ]
        : notes;
      const { error } = await supabase
        .from("qualified_leads")
        .update({
          cs_status: status,
          contact_method: contactMethod,
          called_at: calledAt,
          cs_notes: newNotes as Json,
          followup_at: csPipelineInputValueToUtcIso(followup),
          assigned_to: assignedTo,
          assigned_by: assignedTo
            ? lead.assigned_to === assignedTo
              ? lead.assigned_by
              : auth.user?.id || null
            : null,
          number_name: numberName.trim() || null,
          marketing_notes: compose.trim() || null,
          requirement_1: requirement1.trim() || null,
          requirement_2: requirement2.trim() || null,
          is_important: isImportant,
          pinned_important: pinnedImportantFor(isImportant && lead.pinned_important, status),
        } as never)
        .eq("id", lead.id);
      if (error) throw error;
      const assignedName = assignedTo
        ? (teamById.get(assignedTo)?.full_name ?? teamById.get(assignedTo)?.email ?? "Staff")
        : "Unassigned";
      void syncLeadToGoogleSheet("UPDATE", {
        ...lead,
        cs_status: status,
        contact_method: contactMethod,
        called_at: calledAt,
        number_name: numberName.trim() || null,
        marketing_notes: compose.trim() || null,
        requirement_1: requirement1.trim() || null,
        requirement_2: requirement2.trim() || null,
        assigned_to: assignedTo,
        assigned_to_name: assignedName,
        is_important: isImportant,
        pinned_important: pinnedImportantFor(isImportant && lead.pinned_important, status),
      });
      await supabase.from("activity_logs").insert({
        actor_id: auth.user?.id,
        actor_name: auth.profile?.full_name,
        actor_role: auth.primaryRole,
        action: status !== lead.cs_status ? "cs.status_changed" : "cs.updated",
        entity_type: "qualified_lead",
        entity_id: lead.id,
        metadata: {
          status,
          previous_status: lead.cs_status,
          contact_method: contactMethod,
          called_at: calledAt,
          hasNote: !!note.trim(),
          assigned_to: assignedTo,
          from: "drawer",
        },
      });
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["cs_leads"] });
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-md animate-fade-in-up"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="Lead details"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-card w-full max-w-5xl max-h-[90vh] md:h-[80vh] flex flex-col rounded-2xl border border-border p-6 shadow-2xl overflow-y-auto md:overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header (Static) */}
        <div className="pb-4 border-b border-border flex justify-between items-start gap-4">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-medium">
              Customer
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <h2 className="text-[22px] font-semibold tracking-tight">{lead.customer_name}</h2>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <PhoneCopyLink phone={lead.customer_number} />
              {lead.is_landline && (
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-amber-500/30 dark:text-amber-300">
                  Landline
                </span>
              )}
              {lead.customer_number_2 && <PhoneCopyLink phone={lead.customer_number_2} />}
            </div>
            {canViewForwardMeta && forwardedByText && (
              <div className="mt-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
                <span>Forwarded by:</span>
                <span className="font-medium text-foreground">{forwardedByText}</span>
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleClose}
            aria-label="Close lead details"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 2-Column Body */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:flex-1 md:min-h-0 mt-4 overflow-visible md:overflow-hidden">
          {/* Left Column: Lead Details */}
          <div className="col-span-1 md:col-span-5 space-y-4 overflow-visible md:overflow-y-auto md:pr-4 md:min-h-0">
            <div className="grid grid-cols-2 gap-3">
              {lead.sub_area && <Info label="Area" value={lead.sub_area} />}
              {lead.pass_it_to && <Info label="Pass to" value={lead.pass_it_to} />}
            </div>
            {lead.service && <Info label="Service" value={lead.service} />}
            <Info label="Reference" value={lead.reference || "-"} />
            {canViewForwardMeta && lead.submitted_by_role && (
              <Info label="Submitted by" value={lead.submitted_by_role.toUpperCase()} />
            )}
            {lead.post_text && (
              <Info label="Customer exact requirement" value={lead.post_text} multiline />
            )}
            {lead.context && <Info label="Context" value={lead.context} multiline />}
            {lead.original_lead_link && (
              <div>
                <p className="text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                  Original Post
                </p>
                <a
                  href={lead.original_lead_link}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-primary hover:underline text-sm font-medium"
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  View Post
                </a>
              </div>
            )}
            {canViewAttachments && Array.isArray(lead.images) && lead.images.length > 0 && (
              <LeadAttachmentsGrid refs={lead.images as string[]} />
            )}
          </div>

          {/* Right Column: Edit Form & History */}
          <div className="col-span-1 md:col-span-7 flex flex-col gap-5 overflow-visible md:overflow-y-auto md:pl-4 md:border-l md:border-border pr-2 md:min-h-0">
            {/* Form Fields */}
            <div className="space-y-4">
              <div>
                <Label className="block mb-1.5 text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium">
                  Status
                </Label>
                <StatusPicker
                  value={status}
                  onChange={requestStatusChange}
                  disabled={
                    busy || (!isAdmin && !isCs && (!assignedTo || auth.user?.id !== assignedTo))
                  }
                />
                <div className="mt-3">
                  <ContactMethodToggle
                    value={contactMethod}
                    calledAt={calledAt}
                    onChange={changeDrawerContactMethod}
                    disabled={
                      busy || (!isAdmin && !isCs && (!assignedTo || auth.user?.id !== assignedTo))
                    }
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Checkbox
                  id="drawer-important"
                  checked={isImportant}
                  onCheckedChange={(checked) => setIsImportant(!!checked)}
                  disabled={busy || !(isCs || isAdmin)}
                />
                <Label
                  htmlFor="drawer-important"
                  className="text-[13px] font-medium cursor-pointer flex items-center gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5 text-warning fill-warning/20 animate-pulse" />
                  Mark as Important
                </Label>
              </div>
              <div>
                <Label className="block mb-1.5 text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium">
                  Number Name
                </Label>
                <NumberNameSelect value={numberName} onChange={(v) => setNumberName(v)} />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <Label className="block text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium">
                    Compose
                  </Label>
                  <div className="flex items-center gap-2">
                    <Select
                      onValueChange={(val) => {
                        const selectedTpl = finalTemplates.find((t) => t.id === val);
                        if (selectedTpl) {
                          const generated = renderCsComposeSuggestion(selectedTpl.template, lead);
                          setCompose(generated);
                        }
                      }}
                    >
                      <SelectTrigger className="h-7 w-[160px] text-[11px] py-0 px-2 bg-muted/40 border-dashed">
                        <SelectValue placeholder="Use template..." />
                      </SelectTrigger>
                      <SelectContent>
                        {finalTemplates.map((t) => (
                          <SelectItem key={t.id} value={t.id} className="text-[11.5px]">
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {(lead.context || lead.post_text) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleRephrase}
                        disabled={rephrasing}
                        className="h-7 px-2 text-[11px] border-primary/40 text-primary hover:bg-primary/5 inline-flex items-center"
                      >
                        {rephrasing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5 mr-1 text-primary" />
                        )}
                        Rephrase
                      </Button>
                    )}
                  </div>
                </div>
                <Textarea
                  value={compose}
                  onChange={(e) => setCompose(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="Compose a message or note for this lead..."
                />
                {composeSuggestion && (
                  <ComposeSuggestion
                    suggestion={composeSuggestion}
                    onClick={() => {
                      setCompose(composeSuggestion);
                    }}
                  />
                )}
              </div>
              <div>
                <Label className="block mb-1.5 text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium">
                  Assigned to
                </Label>
                {isAdmin ? (
                  <Select
                    value={assignedTo ?? UNASSIGNED_VALUE}
                    onValueChange={(v) => setAssignedTo(v === UNASSIGNED_VALUE ? null : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                      {team.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.full_name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center justify-between gap-2 px-3 h-10 rounded-md border border-border bg-surface/60 text-[13px]">
                    <span className="inline-flex items-center gap-2 truncate">
                      <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
                      {assignee ? (
                        <span
                          className={cn("truncate", assignedToMe && "text-primary font-medium")}
                        >
                          {assignedToMe ? "You" : assignee.full_name || assignee.email}
                        </span>
                      ) : (
                        <span className="italic text-muted-foreground/70">Unassigned</span>
                      )}
                    </span>
                    {isCs && !assignedToMe && (
                      <Button
                        size="sm"
                        variant={assignedTo ? "outline" : "default"}
                        className="h-7 text-[11.5px] px-2"
                        onClick={() => auth.user?.id && setAssignedTo(auth.user.id)}
                      >
                        <UserPlus className="h-3 w-3 mr-1" />
                        {assignedTo ? "Take over" : "Assign to me"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div>
                <Label className="block mb-1.5 text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium">
                  Follow-up at
                </Label>
                <Input
                  type="datetime-local"
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                />
              </div>
              <div>
                <Label className="block mb-1.5 text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium">
                  Comment
                </Label>
                <Textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Write what happened in your own words — e.g. customer is interested, already done by someone else, asked to message later…"
                />
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  Free-text comment. Appended to the history when you save.
                </p>
              </div>
            </div>

            {/* History / Notes */}
            {notes.length > 0 && (
              <div className="border-t border-border pt-4 mt-2">
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-medium mb-3 flex items-center gap-2">
                  <MessageSquarePlus className="h-3 w-3" /> History · {notes.length}
                </div>
                <div className="space-y-2.5">
                  {[...notes].reverse().map((n, i) => (
                    <div key={i} className="bg-surface/60 border border-border rounded-md p-3">
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {n.by} · {formatCsPipelineDateTime(n.at)}
                      </div>
                      <div className="text-[13px] mt-1 whitespace-pre-wrap leading-relaxed">
                        {n.text}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer: Save / Close / Delete Buttons */}
        <div className="border-t border-border pt-4 mt-4 flex items-center justify-between gap-2 bg-card">
          {isAdmin ? (
            <>
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 h-9 px-3 text-[13px]"
                disabled={busy}
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                Delete lead
              </Button>
              <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete lead</AlertDialogTitle>
                    <AlertDialogDescription>
                      Delete lead for "{lead.customer_name}"? This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={async (e) => {
                        e.preventDefault();
                        setShowDeleteConfirm(false);
                        setBusy(true);
                        try {
                          const { error } = await supabase
                            .from("qualified_leads")
                            .delete()
                            .eq("id", lead.id);
                          if (error) throw error;
                          void syncLeadToGoogleSheet("DELETE", lead);
                          await supabase.from("activity_logs").insert({
                            actor_id: auth.user?.id,
                            actor_name: auth.profile?.full_name,
                            actor_role: auth.primaryRole,
                            action: "cs.deleted",
                            entity_type: "qualified_lead",
                            entity_id: lead.id,
                            metadata: { customer_name: lead.customer_name },
                          });
                          toast.success("Lead deleted");
                          qc.invalidateQueries({ queryKey: ["cs_leads"] });
                          onSaved();
                        } catch (err) {
                          toast.error(friendlyError(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose} disabled={busy}>
              Close
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Save
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ComposeSuggestion({
  suggestion,
  compact = false,
  onClick,
}: {
  suggestion: string;
  compact?: boolean;
  onClick?: () => void;
}) {
  if (!suggestion) return null;
  return (
    <div
      onClick={onClick}
      className={cn(
        "mt-2 rounded-md border border-dashed border-border bg-surface/60 text-muted-foreground transition-colors",
        onClick &&
          "cursor-pointer hover:bg-surface-strong hover:text-foreground hover:border-primary/60",
        compact ? "px-2.5 py-2 text-[11.5px]" : "px-3 py-2.5 text-[12px]",
      )}
      title={onClick ? "Click to insert into compose box" : undefined}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wide font-semibold flex items-center justify-between">
        <span>Suggestion</span>
        {onClick && <span className="text-[9px] text-primary/80 lowercase">Click to apply</span>}
      </div>
      <div className="whitespace-pre-wrap leading-relaxed">{suggestion}</div>
    </div>
  );
}

function Info({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-medium">
        {label}
      </div>
      <div
        className={cn("text-[13px] mt-1 leading-relaxed", multiline ? "whitespace-pre-wrap" : "")}
      >
        {value}
      </div>
    </div>
  );
}

function ComposeTemplatesManager({ userId }: { userId: string | undefined }) {
  const { templates, save, isLoading } = useCsComposeTemplatesList(userId);
  const [items, setItems] = useState<ComposeTemplateItem[]>([]);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Array.isArray(templates) && templates.length > 0) {
      setItems(templates);
    } else {
      setItems(DEFAULT_COMPOSE_TEMPLATES);
    }
  }, [templates]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newTemplate.trim()) {
      toast.error("Name and template content are required");
      return;
    }
    const newItem: ComposeTemplateItem = {
      id: `tpl_${Date.now()}`,
      name: newName.trim(),
      template: newTemplate.trim(),
    };
    const next = [...(Array.isArray(items) ? items : []), newItem];
    setItems(next);
    setNewName("");
    setNewTemplate("");
    setBusy(true);
    try {
      await save(next);
      toast.success("Template added successfully");
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!Array.isArray(items)) return;
    const next = items.filter((item) => item && item.id !== id);
    setItems(next);
    setBusy(true);
    try {
      await save(next);
      toast.success("Template deleted");
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(id: string, name: string, templateText: string) {
    if (!Array.isArray(items)) return;
    const next = items.map((item) =>
      item && item.id === id ? { ...item, name: name.trim(), template: templateText.trim() } : item,
    );
    setItems(next);
    setBusy(true);
    try {
      await save(next);
      toast.success("Template updated");
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Add form */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <MessageSquarePlus className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Create Compose Template</h3>
        </div>
        <form onSubmit={handleAdd} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-1">
              <Label
                htmlFor="tpl-name"
                className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium block mb-1.5"
              >
                Template Name
              </Label>
              <Input
                id="tpl-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Schedule Visit"
                maxLength={60}
              />
            </div>
            <div className="md:col-span-2">
              <Label
                htmlFor="tpl-text"
                className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium block mb-1.5"
              >
                Template Content
              </Label>
              <Textarea
                id="tpl-text"
                value={newTemplate}
                onChange={(e) => setNewTemplate(e.target.value)}
                placeholder="Hi (Person first name), saw that you are looking for (Service Context)..."
                rows={2}
                maxLength={1000}
              />
            </div>
          </div>
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 text-[11.5px] text-muted-foreground bg-muted/20 border border-border px-3 py-2.5 rounded-md">
            <div>
              💡 Placeholders:{" "}
              <code className="font-semibold text-foreground font-mono bg-muted/60 px-1 py-0.5 rounded">
                (Person first name)
              </code>
              ,{" "}
              <code className="font-semibold text-foreground font-mono bg-muted/60 px-1 py-0.5 rounded">
                (Service Context)
              </code>
            </div>
            <Button
              type="submit"
              size="sm"
              className="w-full sm:w-auto"
              disabled={busy || isLoading}
            >
              Add Template
            </Button>
          </div>
        </form>
      </div>

      {/* Templates list */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Active Templates</h3>
        {isLoading ? (
          <div className="text-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading templates...
          </div>
        ) : !Array.isArray(items) || items.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground bg-muted/10 rounded-md">
            No templates configured yet. Click above to create one.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {items
              .filter((item) => item && item.id && item.name && item.template)
              .map((item) => (
                <TemplateRow
                  key={item.id}
                  item={item}
                  busy={busy}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateRow({
  item,
  busy,
  onUpdate,
  onDelete,
}: {
  item: ComposeTemplateItem;
  busy: boolean;
  onUpdate: (id: string, name: string, template: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item?.name || "");
  const [template, setTemplate] = useState(item?.template || "");

  if (!item) return null;

  if (editing) {
    return (
      <div className="glass-card p-4 space-y-3 border border-primary/40 bg-primary/5">
        <div className="space-y-3">
          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1 block">
              Template Name
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template Name"
              maxLength={60}
            />
          </div>
          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1 block">
              Template Content
            </Label>
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Template Content"
              rows={3}
              maxLength={1000}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              await onUpdate(item.id, name, template);
              setEditing(false);
            }}
            disabled={busy}
          >
            Save Changes
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card p-4 flex items-start justify-between gap-4 hover:border-border-strong transition-colors">
      <div className="space-y-2 min-w-0 flex-1">
        <h4 className="text-sm font-semibold text-foreground/90">{item.name}</h4>
        <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {item.template}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => setEditing(true)}
          disabled={busy}
        >
          Edit
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-8 text-xs"
          onClick={() => onDelete(item.id)}
          disabled={busy}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function LeadAttachmentsGrid({ refs }: { refs: string[] }) {
  const urls = useSignedLeadUrls(refs);
  return (
    <div>
      <Label className="block mb-2 text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium">
        Attachments ({refs.length})
      </Label>
      <div className="grid grid-cols-3 gap-2">
        {refs.map((ref, i) => {
          const url = urls[i] ?? ref;
          return (
            <a
              key={ref + i}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block aspect-square rounded-md overflow-hidden border border-border bg-muted hover:opacity-80 transition-opacity"
            >
              <img
                src={url}
                alt="Lead attachment"
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </a>
          );
        })}
      </div>
    </div>
  );
}
