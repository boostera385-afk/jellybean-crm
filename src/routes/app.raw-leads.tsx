import { createFileRoute } from "@tanstack/react-router";
import { RouteSkeleton } from "@/components/route-skeleton";
import { useServerFn } from "@tanstack/react-start";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";
import { useAuth } from "@/hooks/use-auth";
import { syncLeadToGoogleSheet } from "@/lib/google-sheets-sync";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import type { LeadFormValues } from "@/components/lead-form";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  ExternalLink,
  RefreshCw,
  Search,
  Settings as Gear,
  Send,
  Eye,
  PhoneOff,
  Download,
  Copy,
  Sparkles,
  Trash2,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Plus,
  X,
  UserMinus,
  UserPlus,
  Layers,
  ChevronDown,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import { downloadCsv, formatPhone, normalizePhone } from "@/lib/crm-lite";
import {
  analyzeRawLeadsWithAi,
  autoRephraseLeadWithAi,
  FROZEN_LEAD_PROMPT,
} from "@/lib/raw-leads-ai.functions";
import {
  checkDuplicatePhone,
  fetchRawLeadCache,
  fetchRawLeadKeyset,
  fetchRawLeadCounts,
} from "@/lib/raw-leads.functions";
import { calculateTotalPages, calculateLastPageSize } from "@/lib/raw-leads-keyset";

import { confirmDialog, confirmDiscardUnsaved } from "@/components/confirm-dialog-store";
import { saveDraft, deleteDraftForSource, countMyDrafts, type LeadDraft } from "@/lib/lead-drafts";
import { FolderOpen } from "lucide-react";

// Lazy-loaded heavy dialogs — deferred until user opens them
const LeadForm = lazy(() =>
  import("@/components/lead-form").then((m) => ({ default: m.LeadForm })),
);
const DuplicateLeadDialog = lazy(() =>
  import("@/components/duplicate-lead-dialog").then((m) => ({ default: m.DuplicateLeadDialog })),
);
const RawLeadDuplicateDialog = lazy(() =>
  import("@/components/raw-lead-duplicate-dialog").then((m) => ({
    default: m.RawLeadDuplicateDialog,
  })),
);
const DraftsDialog = lazy(() =>
  import("@/components/drafts-dialog").then((m) => ({ default: m.DraftsDialog })),
);

import { canonicalizeLeadLink, extractNextdoorPostId } from "@/lib/lead-link-canonicalizer";
import { formatCsPipelineShortDate } from "@/lib/cs-pipeline-time";
import { type RawLeadCursor } from "@/lib/raw-leads-keyset";

export const Route = createFileRoute("/app/raw-leads")({
  head: () => ({
    meta: [
      { title: "Raw Leads \u00b7 JellyBean" },
      { name: "description", content: "Review and qualify incoming leads in JellyBean." },
      { property: "og:title", content: "Raw Leads \u00b7 JellyBean" },
      { property: "og:description", content: "Review and qualify incoming leads in JellyBean." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
});

const TABLE = "raw_lead_cache";
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
const DEFAULT_PAGE_SIZE = 200;
type RawLeadCacheUpdate = Database["public"]["Tables"]["raw_lead_cache"]["Update"];

// ── Types ─────────────────────────────────────────────────────────────────────
type Row = Record<string, string> & {
  "Account Name"?: string;
  "Sub Area / Neighborhood"?: string;
  "Posted Date & Time"?: string;
  "Post Text"?: string;
  Lead?: string;
  "Lead Link"?: string;
  "Captured Date (UTC)"?: string;
  "Captured Time (UTC)"?: string;
  "Account Area"?: string;
  "Incog Account"?: string;
};

type Category = "forwarded" | "not_found" | "wrong" | "duplicate";
type LeadDecision = "yes" | "no";
type Action = { category?: Category | null; lead?: LeadDecision | null; phone?: string | null };
type CacheEntry = {
  row_key: string;
  data: Row;
  lead: LeadDecision | null;
  phone: string | null;
  category: Category | null;
  captured_at: string | null;
  lead_link: string | null;
  sheet_row: number | null;
  assigned_to: string | null;
  assigned_myself_at: string | null;
  id: string;
  duplicate_detected: boolean | null;
  duplicate_reason: string | null;
  duplicate_match_type: string | null;
  duplicate_key: string | null;
  duplicate_of_raw_lead_id: string | null;
  duplicate_of_qualified_lead_id: string | null;
  canonical_post_id: string | null;
  canonical_lead_link: string | null;
};
type RawLeadPage = {
  entries: CacheEntry[];
  pageSize: number;
  hasMore: boolean;
};
const EMPTY_CACHE_ENTRIES: CacheEntry[] = [];
const SEARCH_DEBOUNCE_MS = 500;
type SortDirection = "asc" | "desc";
type RawLeadSortKey =
  | "account_name"
  | "sub_area"
  | "posted_at"
  | "post_text"
  | "lead"
  | "lead_link"
  | "captured_at"
  | "account_area"
  | "incog_account"
  | "assignment";
type RawLeadSort = { key: RawLeadSortKey; direction: SortDirection };
type DuplicatePhoneMatch = {
  id: string;
  customer_name: string;
  customer_number: string;
  customer_number_2: string | null;
  assigned_at: string;
  service: string | null;
  context: string | null;
  main_area: string | null;
  sub_area: string | null;
  original_lead_link: string | null;
};

const AI_LOCK_KEY = "raw_leads.ai_lock";
const AI_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
type AiLockValue = { user_id: string; started_at: string; user_name?: string | null } | null;

const RAW_LEAD_COLUMNS = [
  "Account Name",
  "Sub Area / Neighborhood",
  "Posted Date & Time",
  "Post Text",
  "Lead",
  "Lead Link",
  "Captured Date and Time (PKT)",
  "Account Area",
  "Incog Account",
] as const;

type RawLeadColumn = (typeof RAW_LEAD_COLUMNS)[number];

const RAW_LEAD_SORT_BY_COLUMN: Record<RawLeadColumn, RawLeadSortKey> = {
  "Account Name": "account_name",
  "Sub Area / Neighborhood": "sub_area",
  "Posted Date & Time": "posted_at",
  "Post Text": "post_text",
  Lead: "lead",
  "Lead Link": "lead_link",
  "Captured Date and Time (PKT)": "captured_at",
  "Account Area": "account_area",
  "Incog Account": "incog_account",
};

function formatPhoneInput(value: string): string {
  const digits = normalizePhone(value);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

// ── Row helpers ───────────────────────────────────────────────────────────────

// Parses relative expressions ("5 minutes ago", "2h", "yesterday", "just now")
// as well as absolute timestamps. Returns NaN when the value can't be
// interpreted so callers can push it to the end of the sort.
function parseRelativeOrAbsolute(value?: string | null): number {
  if (!value) return Number.NaN;
  const raw = String(value).trim();
  if (!raw) return Number.NaN;
  const lower = raw.toLowerCase();
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  if (/^(just\s*now|moments?\s+ago|few\s+seconds?\s+ago|a\s+moment\s+ago)$/.test(lower)) return now;
  if (lower === "yesterday") return now - DAY_MS;
  if (/\bday\s+before\s+yesterday\b/.test(lower)) return now - 2 * DAY_MS;

  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: DAY_MS,
    week: 7 * DAY_MS,
    month: 30 * DAY_MS,
    year: 365 * DAY_MS,
  };
  const unitAlias: Record<string, keyof typeof unitMs> = {
    s: "second",
    sec: "second",
    secs: "second",
    second: "second",
    seconds: "second",
    m: "minute",
    min: "minute",
    mins: "minute",
    minute: "minute",
    minutes: "minute",
    h: "hour",
    hr: "hour",
    hrs: "hour",
    hour: "hour",
    hours: "hour",
    d: "day",
    day: "day",
    days: "day",
    w: "week",
    wk: "week",
    wks: "week",
    week: "week",
    weeks: "week",
    mo: "month",
    mos: "month",
    month: "month",
    months: "month",
    y: "year",
    yr: "year",
    yrs: "year",
    year: "year",
    years: "year",
  };
  const wordNum: Record<string, number> = { a: 1, an: 1 };

  const rel = lower.match(
    /^(?:about\s+|around\s+|over\s+|almost\s+)?(\d+|a|an)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|mo|years?|yrs?|y)\s*ago\b/,
  );
  if (rel) {
    const n = wordNum[rel[1]] ?? Number(rel[1]);
    const unit = unitAlias[rel[2]];
    if (Number.isFinite(n) && unit) return now - n * unitMs[unit];
  }

  const short = lower.match(
    /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|mos|month|months|y|yr|yrs)$/,
  );
  if (short) {
    const n = Number(short[1]);
    const unit = unitAlias[short[2]];
    if (Number.isFinite(n) && unit) return now - n * unitMs[unit];
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function parseDateTime(value?: string | null, time?: string | null): number {
  const joined = [value, time].filter(Boolean).join(" ").trim();
  if (!joined) return Number.NaN;
  const parsed = Date.parse(joined);
  if (!Number.isNaN(parsed)) return parsed;
  return parseRelativeOrAbsolute(joined);
}

const PKT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-PK", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function capturedAtTimestamp(entry: CacheEntry): number {
  const storedTimestamp = entry.captured_at ? Date.parse(entry.captured_at) : Number.NaN;
  if (!Number.isNaN(storedTimestamp)) return storedTimestamp;

  const date = entry.data["Captured Date (UTC)"]?.trim();
  const time = entry.data["Captured Time (UTC)"]?.trim();
  const joined = [date, time].filter(Boolean).join(" ").trim();
  if (!joined) return Number.NaN;

  // Legacy rows only have separate UTC text fields. Adding the explicit zone
  // prevents the browser from interpreting those values as local time.
  const utcTimestamp = Date.parse(`${joined} UTC`);
  return Number.isNaN(utcTimestamp) ? parseDateTime(date, time) : utcTimestamp;
}

function formatCapturedDateTimePkt(entry: CacheEntry): string {
  const timestamp = capturedAtTimestamp(entry);
  if (!Number.isFinite(timestamp)) return "—";
  return `${PKT_DATE_TIME_FORMATTER.format(timestamp)} PKT`;
}

// Detects whether a "Posted Date & Time" string represents a moment more than
// 24 hours in the past. Supports relative formats ("5 hours ago", "2 days ago",
// "1 week ago", "yesterday", "a month ago", etc.) as well as parseable
// absolute timestamps. Returns false when the value is empty/unrecognized so
// that unknown formats don't get an incorrect badge.
function isPostOlderThan24h(value?: string | null): boolean {
  if (!value) return false;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return false;
  const DAY_MS = 24 * 60 * 60 * 1000;

  if (/(just now|moments? ago|few seconds ago)/.test(raw)) return false;
  if (raw === "yesterday" || /\bday before yesterday\b/.test(raw)) return true;

  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: DAY_MS,
    week: 7 * DAY_MS,
    month: 30 * DAY_MS,
    year: 365 * DAY_MS,
  };
  const unitAlias: Record<string, keyof typeof unitMs> = {
    s: "second",
    sec: "second",
    secs: "second",
    second: "second",
    seconds: "second",
    m: "minute",
    min: "minute",
    mins: "minute",
    minute: "minute",
    minutes: "minute",
    h: "hour",
    hr: "hour",
    hrs: "hour",
    hour: "hour",
    hours: "hour",
    d: "day",
    day: "day",
    days: "day",
    w: "week",
    wk: "week",
    wks: "week",
    week: "week",
    weeks: "week",
    mo: "month",
    mos: "month",
    month: "month",
    months: "month",
    y: "year",
    yr: "year",
    yrs: "year",
    year: "year",
    years: "year",
  };
  const wordNum: Record<string, number> = { a: 1, an: 1 };

  // "5 hours ago", "3 hr ago", "an hour ago", "about 2 days ago"
  const rel = raw.match(
    /^(?:about\s+|around\s+|over\s+|almost\s+)?(\d+|a|an)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|mo|years?|yrs?|y)\s*ago\b/,
  );
  if (rel) {
    const n = wordNum[rel[1]] ?? Number(rel[1]);
    const unit = unitAlias[rel[2]];
    if (!Number.isFinite(n) || !unit) return false;
    return n * unitMs[unit] > DAY_MS;
  }

  // Short forms without "ago": "2d", "6d", "3h", "45m", "2w", "1mo", "1y"
  const short = raw.match(
    /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|mos|month|months|y|yr|yrs)$/,
  );
  if (short) {
    const n = Number(short[1]);
    const unit = unitAlias[short[2]];
    if (!Number.isFinite(n) || !unit) return false;
    return n * unitMs[unit] > DAY_MS;
  }

  // Fallback: absolute timestamp
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return Date.now() - parsed > DAY_MS;
  }
  return false;
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Sentinel returned by rawLeadSortValue when the underlying cell is empty
// or otherwise unrankable. The comparator always pushes these to the end,
// regardless of asc/desc direction.
const SORT_EMPTY = Symbol("sort-empty");
type SortValue = number | string | typeof SORT_EMPTY;

function textOrEmpty(value: string | null | undefined): SortValue {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : SORT_EMPTY;
}

function numberOrEmpty(value: number): SortValue {
  return Number.isFinite(value) ? value : SORT_EMPTY;
}

function rawLeadSortValue(
  entry: CacheEntry,
  key: RawLeadSortKey,
  actions: Record<string, Action>,
  currentUserId: string | null,
): SortValue {
  const r = entry.data;
  switch (key) {
    case "account_name":
      return textOrEmpty(r["Account Name"]);
    case "sub_area":
      return textOrEmpty(r["Sub Area / Neighborhood"]);
    case "posted_at":
      return numberOrEmpty(parseRelativeOrAbsolute(r["Posted Date & Time"]));
    case "post_text":
      return textOrEmpty(r["Post Text"]);
    case "lead": {
      const lead = effectiveLead(r, actions[entry.row_key]);
      if (lead === "yes") return 0;
      if (lead === "no") return 1;
      return SORT_EMPTY;
    }
    case "lead_link":
      return textOrEmpty(r["Lead Link"]);
    case "captured_at":
      return numberOrEmpty(capturedAtTimestamp(entry));
    case "account_area":
      return textOrEmpty(r["Account Area"]);
    case "incog_account":
      return textOrEmpty(r["Incog Account"]);
    case "assignment": {
      // Logical rank: assigned-to-you < claimed < unassigned. Unassigned is
      // meaningful (not empty) — keep it ranked so it trails in asc and
      // leads in desc, per spec.
      if (!entry.assigned_to) return 2;
      return entry.assigned_to === currentUserId ? 0 : 1;
    }
  }
}

function compareSortValues(av: SortValue, bv: SortValue): number {
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return compareText(String(av), String(bv));
}

function compareRawLeadEntries(
  a: CacheEntry,
  b: CacheEntry,
  sort: RawLeadSort,
  actions: Record<string, Action>,
  currentUserId: string | null,
  indexA: number,
  indexB: number,
) {
  const av = rawLeadSortValue(a, sort.key, actions, currentUserId);
  const bv = rawLeadSortValue(b, sort.key, actions, currentUserId);
  const aEmpty = av === SORT_EMPTY;
  const bEmpty = bv === SORT_EMPTY;
  if (aEmpty && !bEmpty) return 1;
  if (!aEmpty && bEmpty) return -1;
  if (aEmpty && bEmpty) return indexA - indexB;
  const raw = compareSortValues(av, bv);
  const directional = sort.direction === "asc" ? raw : -raw;
  return directional !== 0 ? directional : indexA - indexB;
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-full items-center justify-between gap-1 text-left font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      <Icon className="h-3 w-3 shrink-0" />
    </button>
  );
}

function leadValueFromRow(r: Row): "yes" | "no" | null {
  const raw = (r.Lead ?? "").trim().toLowerCase();
  if (raw === "yes" || raw === "y" || raw === "true") return "yes";
  if (raw === "no" || raw === "n" || raw === "false") return "no";
  if (raw === "review" || raw === "maybe") return "no";
  return null;
}

function effectiveLead(r: Row, a: Action | undefined): "yes" | "no" | "" {
  // User override (from Supabase action cache) always wins over the sheet value,
  // otherwise once the sheet says a value the dropdown can never be changed.
  if (a?.lead === "yes" || a?.lead === "no") return a.lead;
  const base = leadValueFromRow(r);
  if (base) return base;
  return "";
}

// ── Supabase cache helpers ────────────────────────────────────────────────────
// NOTE: Raw-lead reads go through the `fetchRawLeadCache` server function.
// A previous `loadCache()` helper here fetched the table twice (all rows + a
// second query for uncategorised rows) and was unused — removed to prevent
// accidental reintroduction of that double-scan pattern.

async function patchEntry(row_key: string, patch: Partial<CacheEntry>) {
  const { error } = await supabase
    .from(TABLE)
    .update(patch as RawLeadCacheUpdate)
    .eq("row_key", row_key);
  if (error) throw error;
}

async function loadAiLock(): Promise<AiLockValue> {
  const { data, error } = await supabase
    .from("shared_state")
    .select("value")
    .eq("key", AI_LOCK_KEY)
    .maybeSingle();
  if (error) return null;
  return (data?.value as AiLockValue) ?? null;
}

async function writeAiLock(value: AiLockValue, userId: string | null) {
  const payload = {
    key: AI_LOCK_KEY,
    value: (value ?? {}) as unknown as Record<string, unknown>,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("shared_state")
    .upsert(payload as never, { onConflict: "key" });
  if (error) throw error;
}

// ── Page ──────────────────────────────────────────────────────────────────────
function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Raw Leads"
        description="Live feed from your scraper extension. Stored in Supabase — shared across all your devices."
      />
      <PageBody className="!pt-5">
        <RoleGate
          allow={["admin", "sub_admin", "scraping", "maturing", "acc_handler"]}
          current={auth.primaryRole}
        >
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

// When the loaded page holds this many (or more) unchecked leads, the AI
// auto-checks them in batches of this size on its own — no toggle, no manual
// stop — until fewer than this many unchecked leads remain.
const AUTO_CHECK_THRESHOLD = 50;

function Inner() {
  const auth = useAuth();
  const qc = useQueryClient();
  const analyzeWithAi = useServerFn(analyzeRawLeadsWithAi);
  const fetchRawLeads = useServerFn(fetchRawLeadKeyset);
  const fetchCounts = useServerFn(fetchRawLeadCounts);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const nextdoorWebhookUrl =
    typeof window === "undefined" ? "" : `${window.location.origin}/api/public/nextdoor-leads`;

  const [tab, setTab] = useState<
    "new" | "forwarded" | "not_found" | "wrong" | "duplicate" | "assigned_myself"
  >("new");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [leadFilter, setLeadFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [duplicateFilter, setDuplicateFilter] = useState<"all" | "duplicates" | "unique">("all");
  const [rawLeadSort, setRawLeadSort] = useState<RawLeadSort>({
    key: "posted_at",
    direction: "desc",
  });
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);
  const [currentCursor, setCurrentCursor] = useState<RawLeadCursor | "last" | null>(null);
  const [detailFor, setDetailFor] = useState<CacheEntry | null>(null);
  const [duplicateDetailsFor, setDuplicateDetailsFor] = useState<CacheEntry | null>(null);
  const [qualifyFor, setQualifyFor] = useState<CacheEntry | null>(null);
  const [qualifySecondPhone, setQualifySecondPhone] = useState("");
  const [qualifyDraft, setQualifyDraft] = useState<LeadDraft | null>(null);
  const [draftsOpen, setDraftsOpen] = useState(false);

  const [aiPrompt, setAiPrompt] = useState(FROZEN_LEAD_PROMPT);
  const [promptDirty, setPromptDirty] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const isAdmin = auth.primaryRole === "admin" || auth.primaryRole === "sub_admin";

  const promptQuery = useQuery({
    queryKey: ["lead-ai-prompt"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_state")
        .select("value")
        .eq("key", "lead_ai_prompt")
        .maybeSingle();
      if (error) {
        // Do not silently swallow — surface so admins know saved prompt didn't load.
        console.error("[lead-ai-prompt] failed to load saved prompt:", error);
        toast.error("Could not load saved AI prompt — using built-in default");
        throw error;
      }
      const v = data?.value as { text?: string } | null;
      return v?.text || FROZEN_LEAD_PROMPT;
    },
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Sync remote prompt into local state unless user has unsaved edits
  const remotePrompt = promptQuery.data;
  if (remotePrompt && !promptDirty && remotePrompt !== aiPrompt) {
    // schedule via microtask-safe setState
    queueMicrotask(() => setAiPrompt(remotePrompt));
  }

  const savePrompt = async () => {
    if (!isAdmin) return;
    setSavingPrompt(true);
    try {
      const { error } = await supabase.from("shared_state").upsert(
        {
          key: "lead_ai_prompt",
          value: { text: aiPrompt } as never,
          updated_by: currentUserId,
          updated_at: new Date().toISOString(),
        } as never,
        { onConflict: "key" },
      );
      if (error) throw error;
      setPromptDirty(false);
      toast.success("Prompt saved for all users");
      qc.invalidateQueries({ queryKey: ["lead-ai-prompt"] });
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSavingPrompt(false);
    }
  };

  const [aiRunning, setAiRunning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const toggleRawLeadSort = useCallback((key: RawLeadSortKey) => {
    setRawLeadSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "posted_at" ? "desc" : "asc" },
    );
  }, []);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const currentUserId = auth.user?.id ?? null;
  const currentUserName = auth.profile?.full_name || auth.user?.email || null;
  const canRunAi =
    auth.primaryRole === "admin" ||
    auth.primaryRole === "sub_admin" ||
    auth.primaryRole === "maturing";

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setQuery(queryInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [queryInput]);

  // ── Lightweight cross-user broadcast for bulk moves ────────────────────────
  // Uses Supabase Realtime broadcast (no DB writes) so every raw-leads viewer
  // sees a toast + refresh when someone bulk-moves posts. This prevents the
  // "posts randomly disappeared" confusion.
  useEffect(() => {
    const channel = supabase
      .channel("raw-leads-bulk-moves")
      .on("broadcast", { event: "bulk-move" }, (payload) => {
        const data = (payload.payload ?? {}) as {
          actorId?: string | null;
          actorName?: string | null;
          message?: string;
        };
        if (!data.message) return;
        if (data.actorId && data.actorId === currentUserId) return;
        const who = data.actorName ? ` by ${data.actorName}` : "";
        toast.info(`${data.message}${who}`);
        qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
        qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUserId, qc]);

  const broadcastBulkMove = useCallback(
    (message: string) => {
      void supabase.channel("raw-leads-bulk-moves").send({
        type: "broadcast",
        event: "bulk-move",
        payload: { actorId: currentUserId, actorName: currentUserName, message },
      });
    },
    [currentUserId, currentUserName],
  );

  // ── Persistent cache from Supabase ─────────────────────────────────────────
  const isUnfiltered =
    query === "" && leadFilter === "all" && areaFilter === "all" && duplicateFilter === "all";

  // Tab badge counts — served from a pre-aggregated materialized view via one
  // scalar RPC. These same numbers drive pagination, so we no longer fire a
  // second exact COUNT(*) over raw_lead_cache (previously ~100K calls/day).
  const countsQuery = useQuery({
    queryKey: ["raw-lead-counts"],
    queryFn: async () =>
      (await fetchCounts({ data: {} })) as {
        new: number;
        review: number;
        forwarded: number;
        not_found: number;
        wrong: number;
        duplicate: number;
        assigned_myself: number;
      },
    staleTime: 20_000,
    // Auto-refresh the tab badges. Cheap scalar RPC over a materialized view,
    // and React Query pauses interval refetches while the tab is hidden, so
    // this only runs while someone is looking at the page (no realtime cost).
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  // Map of user id → display name so admins/sub-admins can see which user a
  // lead is assigned to (including after it's moved to another section).
  // Only admins/sub-admins can read other users' profiles (RLS), so the query
  // is enabled for them alone; everyone else keeps the plain "Claimed" label.
  const assigneeNamesQuery = useQuery({
    queryKey: ["raw-lead-assignee-names"],
    enabled: isAdmin,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, username, email");
      if (error) throw error;
      const map = new Map<string, string>();
      for (const p of (data ?? []) as Array<{
        user_id: string;
        full_name: string | null;
        username: string | null;
        email: string | null;
      }>) {
        if (p.user_id) map.set(p.user_id, p.full_name || p.username || p.email || "Unknown user");
      }
      return map;
    },
  });
  const assigneeNameFor = (userId: string | null | undefined) =>
    (userId && assigneeNamesQuery.data?.get(userId)) || null;

  const exactCountQuery = countsQuery;
  const exactCount = isUnfiltered ? countsQuery.data?.[tab] : undefined;
  const totalPages =
    typeof exactCount === "number" ? calculateTotalPages(exactCount, pageSize) : undefined;
  const lastPageSize =
    typeof exactCount === "number" ? calculateLastPageSize(exactCount, pageSize) : undefined;

  const cacheKey = useMemo(
    () =>
      [
        "raw-lead-cache",
        tab,
        currentCursor === "last" ? "last" : (currentCursor?.id ?? "first"),
        pageSize,
        query,
        leadFilter,
        areaFilter,
        duplicateFilter,
      ] as const,
    [tab, currentCursor, pageSize, query, leadFilter, areaFilter, duplicateFilter],
  );

  const cacheQuery = useQuery({
    queryKey: cacheKey,
    queryFn: async () =>
      (await fetchRawLeads({
        data: {
          limit: pageSize,
          cursor: currentCursor === "last" ? null : currentCursor,
          direction: "next",
          category: tab,
          query,
          leadFilter,
          areaFilter,
          duplicateFilter,
        },
      })) as RawLeadPage,
    placeholderData: keepPreviousData,
    gcTime: Infinity,
    // Auto-refresh the current page so newly scraped leads appear without a
    // manual refresh. Polling (not realtime) keeps this off the exceeded
    // Realtime-Messages quota; keepPreviousData avoids flicker and preserves
    // selection, and background refetches pause while the tab is hidden.
    // Pause auto-refresh while a search/filter is active so we don't re-run the
    // heavier filtered query on a timer (and don't shift results while reading).
    refetchInterval: isUnfiltered ? 30_000 : false,
    refetchOnWindowFocus: true,
  });

  const [navigating, setNavigating] = useState(false);

  const navigateTo = async (
    direction: "next" | "previous" | "last",
    targetCursor: RawLeadCursor | "last" | null,
    targetPageNumber: number,
  ) => {
    setNavigating(true);
    try {
      await qc.fetchQuery({
        queryKey: [
          "raw-lead-cache",
          tab,
          targetCursor === "last" ? "last" : (targetCursor?.id ?? "first"),
          pageSize,
          query,
          leadFilter,
          areaFilter,
          duplicateFilter,
        ],
        queryFn: async () =>
          (await fetchRawLeads({
            data: {
              limit: pageSize,
              cursor: targetCursor === "last" ? null : targetCursor,
              direction,
              lastPageSize: direction === "last" ? lastPageSize : undefined,
              category: tab,
              query,
              leadFilter,
              areaFilter,
              duplicateFilter,
            },
          })) as RawLeadPage,
      });
      setCurrentPage(targetPageNumber);
      setCurrentCursor(targetCursor);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setNavigating(false);
    }
  };

  const resetPagination = useCallback(() => {
    setCurrentCursor(null);
    setCurrentPage(1);
  }, []);

  const draftCountQuery = useQuery({
    queryKey: ["lead-drafts-count", auth.user?.id, "raw_lead"],
    queryFn: () => countMyDrafts(auth.user!.id, "raw_lead"),
    enabled: !!auth.user?.id,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const hasDraftLeads = (draftCountQuery.data ?? 0) > 0;

  const updateCachedEntries = useCallback(
    (updater: (entry: CacheEntry) => CacheEntry) => {
      qc.setQueryData<RawLeadPage>(cacheKey as unknown as readonly unknown[], (prev) => {
        if (!prev) return prev;
        return { ...prev, entries: prev.entries.map(updater) };
      });
    },
    [cacheKey, qc],
  );

  const removeCachedEntries = useCallback(
    (shouldRemove: (entry: CacheEntry) => boolean) => {
      qc.setQueryData<RawLeadPage>(cacheKey as unknown as readonly unknown[], (prev) => {
        if (!prev) return prev;
        return { ...prev, entries: prev.entries.filter((entry) => !shouldRemove(entry)) };
      });
    },
    [cacheKey, qc],
  );

  const deleteSelected = useCallback(async () => {
    if (!isAdmin || selected.size === 0) return;
    const keys = Array.from(selected);
    setDeleting(true);
    try {
      const CHUNK = 25;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        const { error } = await supabase.from(TABLE).delete().in("row_key", slice);
        if (error) throw error;
      }
      removeCachedEntries((entry) => selected.has(entry.row_key));
      toast.success(`Deleted ${keys.length} lead${keys.length === 1 ? "" : "s"}`);
      setSelected(new Set());
      setConfirmDelete(false);
    } catch (e) {
      toast.error(friendlyError(e));
      cacheQuery.refetch();
    } finally {
      setDeleting(false);
    }
  }, [isAdmin, selected, removeCachedEntries, cacheQuery]);

  // ── Shared AI lock so two users can't fire the AI batch at once ───────────
  const aiLockQuery = useQuery({
    queryKey: ["raw-leads-ai-lock"],
    queryFn: loadAiLock,
    refetchOnWindowFocus: false,
  });
  const aiLock = aiLockQuery.data ?? null;
  const aiLockActive =
    !!aiLock?.started_at && Date.now() - new Date(aiLock.started_at).getTime() < AI_LOCK_MAX_AGE_MS;
  const aiLockedByOther = aiLockActive && aiLock?.user_id !== currentUserId;

  // Build action map keyed by row_key for fast lookup
  const entries: CacheEntry[] = cacheQuery.data?.entries ?? EMPTY_CACHE_ENTRIES;
  const actions = useMemo(() => {
    const m: Record<string, Action> = {};
    for (const e of entries) {
      m[e.row_key] = { lead: e.lead, phone: e.phone, category: e.category };
    }
    return m;
  }, [entries]);

  async function handleBulkMove(destination: "wrong" | "duplicate") {
    const targets = entries.filter((entry) =>
      destination === "wrong"
        ? entry.category === null && effectiveLead(entry.data, actions[entry.row_key]) === "no"
        : entry.category === null && entry.duplicate_detected === true,
    );
    if (targets.length === 0) {
      toast.info(
        destination === "wrong" ? "No 'No' leads to move." : "No duplicate leads to move.",
      );
      return;
    }

    const destinationLabel = destination === "wrong" ? "Wrong posts" : "Duplicate";
    const keys = targets.map((entry) => entry.row_key);
    const keySet = new Set(keys);
    updateCachedEntries((entry) =>
      keySet.has(entry.row_key) ? { ...entry, category: destination } : entry,
    );
    try {
      const CHUNK = 25;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        const { error } = await supabase
          .from(TABLE)
          .update({
            category: destination,
            categorized_by: currentUserId,
            categorized_at: new Date().toISOString(),
          } as RawLeadCacheUpdate)
          .in("row_key", slice);
        if (error) throw error;
      }
      qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
      qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
      const message = `Moved ${targets.length} lead${targets.length === 1 ? "" : "s"} to ${destinationLabel}`;
      toast.success(message);
      broadcastBulkMove(message);
    } catch (e) {
      toast.error(friendlyError(e));
      cacheQuery.refetch();
    }
  }

  const updateAction = useCallback(
    async (k: string, patch: Partial<Action>) => {
      // When a user changes the category, remember who/when so reports can show it.
      const enriched: Record<string, unknown> = { ...patch };
      if ("category" in patch) {
        enriched.categorized_by = currentUserId;
        enriched.categorized_at = new Date().toISOString();
      }
      // Optimistic update of fields we render
      updateCachedEntries((e) => (e.row_key === k ? { ...e, ...patch } : e));
      try {
        await patchEntry(k, enriched as Partial<CacheEntry>);
        if ("category" in patch) {
          await supabase.from("activity_logs").insert({
            actor_id: currentUserId,
            actor_name:
              auth.profile?.full_name ?? auth.profile?.username ?? auth.profile?.email ?? null,
            actor_role: auth.primaryRole,
            action: `raw.category.${patch.category ?? "new"}`,
            entity_type: "raw_lead_cache",
            metadata: { row_key: k, category: patch.category ?? null },
          });
          // Refresh counts / pagination since the row may have moved categories.
          qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
          qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
        }
      } catch (e) {
        toast.error(friendlyError(e));
        cacheQuery.refetch();
      }
    },
    [auth.primaryRole, auth.profile, cacheQuery, currentUserId, qc, updateCachedEntries],
  );

  const isFetching = cacheQuery.isFetching;
  const error = cacheQuery.error as Error | null;

  // Server-side category counts (for tab badges + pagination total)
  const tabCounts = countsQuery.data ?? {
    new: 0,
    review: 0,
    forwarded: 0,
    not_found: 0,
    wrong: 0,
    duplicate: 0,
    assigned_myself: 0,
  };
  // Removed totalCount and totalPages since keyset pagination does not use exact counts

  const areaOptions = useMemo(() => {
    const areas = new Set<string>();
    for (const e of entries) {
      const area = e.data["Account Area"]?.trim() || e.data["Sub Area / Neighborhood"]?.trim();
      if (area) areas.add(area);
    }
    return Array.from(areas).sort();
  }, [entries]);

  // Entries are filtered server-side for category, search, lead state, and area.
  const visible = useMemo(() => {
    const indexed = entries.map((entry, index) => ({ entry, index }));
    indexed.sort((a, b) =>
      compareRawLeadEntries(
        a.entry,
        b.entry,
        rawLeadSort,
        actions,
        currentUserId,
        a.index,
        b.index,
      ),
    );
    return indexed.map((item) => item.entry);
  }, [actions, currentUserId, entries, rawLeadSort]);

  const shownRows = visible;

  // Only feed AI rows that haven't been classified yet (no sheet Lead value
  // AND no user/AI override), so each click marches through the next 50.
  // These conditions must mirror the server's acceptance filter in
  // analyzeRawLeadsWithAi: it skips duplicate-flagged leads and posts shorter
  // than 20 chars. Counting them here would make a "batch of 50" get trimmed
  // server-side to a smaller number (and could keep uncheckedCount stuck above
  // the auto-check threshold forever), so we exclude them up front.
  const uncheckedTargets = visible.filter(
    (entry) =>
      !entry.duplicate_detected &&
      (entry.data["Post Text"]?.trim().length ?? 0) >= 20 &&
      effectiveLead(entry.data, actions[entry.row_key]) === "",
  );
  // Total unchecked leads loaded on the current page — drives auto-checking.
  const uncheckedCount = uncheckedTargets.length;
  const aiTargets = uncheckedTargets.slice(0, AUTO_CHECK_THRESHOLD);

  function exportRows() {
    downloadCsv(
      "raw-leads.csv",
      ["Account", "Sub Area", "Posted", "Lead", "Phone", "Area", "Incog Account", "Link"],
      visible.map((entry) => [
        entry.data["Account Name"] ?? "",
        entry.data["Sub Area / Neighborhood"] ?? "",
        entry.data["Posted Date & Time"] ?? "",
        effectiveLead(entry.data, actions[entry.row_key]) || "",
        formatPhone(entry.phone),
        entry.data["Account Area"] ?? "",
        entry.data["Incog Account"] ?? "",
        entry.data["Lead Link"] ?? "",
      ]),
    );
    toast.success(`Exported ${visible.length} raw lead${visible.length === 1 ? "" : "s"}`);
  }

  function handleRefresh() {
    cacheQuery.refetch();
    countsQuery.refetch();
    aiLockQuery.refetch();
  }

  const assignToSelf = useCallback(
    async (entry: CacheEntry) => {
      if (!currentUserId) {
        toast.error("Sign in first.");
        return;
      }
      if (entry.assigned_to && entry.assigned_to !== currentUserId) {
        toast.error("Already claimed by another user.");
        return;
      }
      const now = new Date().toISOString();
      // Optimistic: immediately remove from the current tab (e.g. New) so the
      // lead moves to Assigned Myself without needing a full page refresh.
      removeCachedEntries((e) => e.row_key === entry.row_key);
      const { error } = await supabase
        .from(TABLE)
        // Only claim if still unassigned — race-safe.
        .update({
          assigned_to: currentUserId,
          assigned_myself_at: now,
        } as RawLeadCacheUpdate)
        .eq("row_key", entry.row_key)
        .is("assigned_to", null);
      if (error) {
        toast.error(friendlyError(error));
        cacheQuery.refetch();
        return;
      }
      toast.success("Lead assigned to you");
      // Invalidate all tab caches so counts and Assigned Myself tab refresh.
      qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
      qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
    },
    [cacheQuery, currentUserId, qc, removeCachedEntries],
  );

  // ── Bulk "assign N yes-leads to me" ──────────────────────────────────────
  const [assignCount, setAssignCount] = useState(10);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const bulkAssignYesLeads = useCallback(async () => {
    if (!currentUserId) {
      toast.error("Sign in first.");
      return;
    }
    if (bulkAssigning) return;
    setBulkAssigning(true);
    try {
      // The DB function claims rows atomically with FOR UPDATE SKIP LOCKED, so
      // several users pressing this at once never grab the same leads and none
      // of the calls fail — each just takes the next available unclaimed rows.
      const { data, error } = await supabase.rpc(
        "assign_raw_leads_to_me" as never,
        {
          p_limit: assignCount,
        } as never,
      );
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const assigned = typeof data === "number" ? data : Number(data ?? 0);
      if (!assigned) {
        toast.info('No unassigned "Yes" leads available to assign right now.');
      } else if (assigned < assignCount) {
        toast.success(
          `Assigned ${assigned} lead${assigned === 1 ? "" : "s"} to you — only ${assigned} were available.`,
        );
      } else {
        toast.success(`Assigned ${assigned} leads to you.`);
      }
      qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
      qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
    } finally {
      setBulkAssigning(false);
    }
  }, [assignCount, bulkAssigning, currentUserId, qc]);

  const unassignFromSelf = useCallback(
    async (entry: CacheEntry) => {
      if (!currentUserId) {
        toast.error("Sign in first.");
        return;
      }
      if (entry.assigned_to !== currentUserId) {
        toast.error("Only your own claimed leads can be unassigned.");
        return;
      }
      updateCachedEntries((e) =>
        e.row_key === entry.row_key ? { ...e, assigned_to: null, assigned_myself_at: null } : e,
      );
      const { error } = await supabase
        .from(TABLE)
        .update({ assigned_to: null, assigned_myself_at: null } as RawLeadCacheUpdate)
        .eq("row_key", entry.row_key)
        .eq("assigned_to", currentUserId);
      if (error) {
        toast.error(friendlyError(error));
        cacheQuery.refetch();
        return;
      }
      toast.success("Lead unassigned");
      // Refresh both assigned_myself and new tab caches
      qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
      qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
    },
    [cacheQuery, currentUserId, qc, updateCachedEntries],
  );

  async function runAiLeadCheck() {
    if (!canRunAi) {
      toast.error("You don't have permission to run AI lead checks.");
      return;
    }
    const prompt = aiPrompt.trim();
    if (!prompt) {
      toast.error("Write a prompt first.");
      return;
    }
    if (aiTargets.length === 0) {
      toast.info("No visible raw leads with post text to analyze.");
      return;
    }
    if (aiLockedByOther) {
      toast.error("Another user is already running an AI batch. Wait for it to finish.");
      return;
    }

    setAiRunning(true);
    try {
      await writeAiLock(
        {
          user_id: currentUserId!,
          user_name: currentUserName,
          started_at: new Date().toISOString(),
        },
        currentUserId,
      );
      qc.invalidateQueries({ queryKey: ["raw-leads-ai-lock"] });

      const result = await analyzeWithAi({
        data: {
          prompt,
          rowKeys: aiTargets.map((entry) => entry.row_key),
        },
      });
      const leadByKey = new Map(
        result.results
          .filter((item) => item.lead === "yes" || item.lead === "no")
          .map((item) => [item.row_key, item.lead as "yes" | "no"]),
      );
      updateCachedEntries((entry) => {
        const lead = leadByKey.get(entry.row_key);
        return lead ? { ...entry, lead } : entry;
      });
      toast.success(`AI checked ${result.analyzed}: ${result.yes} Yes, ${result.no} No`);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      try {
        await writeAiLock(null, currentUserId);
      } catch {
        /* ignore */
      }
      qc.invalidateQueries({ queryKey: ["raw-leads-ai-lock"] });
      setAiRunning(false);
    }
  }

  // Auto-check: while the loaded page holds AUTO_CHECK_THRESHOLD+ unchecked
  // leads, keep firing batches on their own until fewer than that remain. There
  // is no toggle and no manual stop — it stays "locked" while the backlog is
  // large. When new leads push the count back over the threshold it resumes.
  const autoActive =
    canRunAi && !!aiPrompt.trim() && !aiLockedByOther && uncheckedCount >= AUTO_CHECK_THRESHOLD;

  const autoActiveRef = useRef(autoActive);
  autoActiveRef.current = autoActive;

  const runAiLeadCheckRef = useRef(runAiLeadCheck);
  runAiLeadCheckRef.current = runAiLeadCheck;

  useEffect(() => {
    if (aiRunning || !autoActive) return;
    const timer = setTimeout(() => {
      if (autoActiveRef.current) {
        runAiLeadCheckRef.current();
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [aiRunning, autoActive]);

  return (
    <div className="space-y-4">
      {/* Tabs + search bar */}
      <div className="crm-toolbar-panel">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-surface border border-border">
            {(
              [
                ["new", "New", tabCounts.new],
                ["forwarded", "Forwarded", tabCounts.forwarded],
                ["not_found", "Number not found", tabCounts.not_found],
                ["duplicate", "Duplicate", tabCounts.duplicate],
                ["wrong", "Wrong posts", tabCounts.wrong],
                ["assigned_myself", "Assigned Myself", tabCounts.assigned_myself],
              ] as const
            ).map(([k, label, n]) => (
              <button
                key={k}
                onClick={() => {
                  setTab(k);
                  resetPagination();
                }}
                className={cn(
                  "crm-motion px-3 h-8 text-[12px] font-medium rounded-md inline-flex items-center gap-1.5",
                  tab === k
                    ? "bg-card text-foreground shadow-sm ring-1 ring-border-strong"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={tab === k}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    k === "forwarded" && "bg-success",
                    k === "not_found" && "bg-warning",
                    (k === "wrong" || k === "duplicate") && "bg-destructive",
                    k === "assigned_myself" && "bg-primary",
                    k === "new" && "bg-primary-glow",
                  )}
                />
                {label}
                <span className="ml-0.5 text-[10.5px] text-muted-foreground tabular-nums">{n}</span>
              </button>
            ))}
          </div>

          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={queryInput}
              onChange={(e) => {
                setQueryInput(e.target.value);
                resetPagination();
              }}
              placeholder="Search…"
              className="h-9 pl-9"
            />
          </div>

          <Select
            value={leadFilter}
            onValueChange={(value) => {
              setLeadFilter(value);
              resetPagination();
            }}
          >
            <SelectTrigger className="h-9 w-[118px] text-[12px]">
              <SelectValue placeholder="Lead" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All leads</SelectItem>
              <SelectItem value="yes">Lead yes</SelectItem>
              <SelectItem value="no">Lead no</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={areaFilter}
            onValueChange={(value) => {
              setAreaFilter(value);
              resetPagination();
            }}
          >
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

          <Select
            value={duplicateFilter}
            onValueChange={(value) => {
              setDuplicateFilter(value as "all" | "duplicates" | "unique");
              resetPagination();
            }}
          >
            <SelectTrigger className="h-9 w-[140px] text-[12px]">
              <SelectValue placeholder="Duplicates" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All posts</SelectItem>
              <SelectItem value="duplicates">Duplicates only</SelectItem>
              <SelectItem value="unique">Unique only</SelectItem>
            </SelectContent>
          </Select>

          {tab === "new" && (
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              onClick={() => void handleBulkMove("wrong")}
            >
              <PhoneOff className="h-3.5 w-3.5 mr-1.5" />
              Move "No" → Wrong posts
            </Button>
          )}

          {tab === "new" && (
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              onClick={() => void handleBulkMove("duplicate")}
            >
              <Layers className="h-3.5 w-3.5 mr-1.5" />
              Move duplicates → Duplicate
            </Button>
          )}

          {tab === "new" && (
            <div className="inline-flex">
              <Button
                size="sm"
                variant="outline"
                className="h-9 rounded-r-none border-r-0"
                onClick={() => void bulkAssignYesLeads()}
                disabled={bulkAssigning || !currentUserId}
                title={`Assign the next ${assignCount} unclaimed "Yes" leads to you`}
              >
                {bulkAssigning ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                )}
                Assign {assignCount} to me
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 rounded-l-none px-1.5"
                    disabled={bulkAssigning || !currentUserId}
                    aria-label="Choose how many leads to assign"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[9rem]">
                  {[10, 20, 30].map((n) => (
                    <DropdownMenuItem
                      key={n}
                      onClick={() => setAssignCount(n)}
                      className="text-[12.5px]"
                    >
                      Assign {n} to me
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              onClick={() => setSettingsOpen(true)}
              title="Web App URL"
            >
              <Gear className="h-3.5 w-3.5 mr-1.5" /> Source
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              onClick={handleRefresh}
              disabled={isFetching}
            >
              {isFetching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="relative h-9"
              onClick={() => setDraftsOpen(true)}
              title={hasDraftLeads ? "Draft contains leads" : "View saved drafts"}
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
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

            {auth.primaryRole === "admin" && (
              <Button size="sm" variant="outline" className="h-9" onClick={exportRows}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export
              </Button>
            )}
          </div>
        </div>
      </div>

      {isAdmin && selected.size > 0 && (
        <div className="crm-toolbar-panel flex items-center gap-2 text-[12.5px]">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 ml-auto"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete selected
          </Button>
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !deleting && setConfirmDelete(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} lead{selected.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected raw leads. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deleteSelected();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canRunAi && (
        <div className="crm-section-panel space-y-1">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-2 items-start">
            <div className="space-y-1">
              <Textarea
                value={aiPrompt}
                onChange={(e) => {
                  if (!isAdmin) return;
                  setAiPrompt(e.target.value);
                  setPromptDirty(true);
                }}
                readOnly={!isAdmin}
                rows={6}
                maxLength={4000}
                placeholder="Prompt for AI lead checking..."
                className="min-h-[140px] text-[12.5px]"
              />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {isAdmin
                    ? "Editable by admin & sub-admin — saved prompt syncs to every user in real time."
                    : "Prompt is managed by admin. Synced live."}
                </span>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant={promptDirty ? "default" : "outline"}
                    className="h-7"
                    onClick={savePrompt}
                    disabled={!promptDirty || savingPrompt}
                  >
                    {savingPrompt ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                    {promptDirty ? "Save prompt" : "Saved"}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2 shrink-0">
              <Button
                className="h-14 lg:w-[210px]"
                onClick={() => runAiLeadCheck()}
                disabled={
                  autoActive || // auto mode is locked — no manual stop
                  aiRunning ||
                  aiLockedByOther ||
                  aiTargets.length === 0
                }
                title={
                  aiLockedByOther
                    ? `AI is busy — ${aiLock?.user_name ?? "another user"} is processing leads`
                    : autoActive
                      ? "Auto-checking in batches of 50 — runs on its own until fewer than 50 unchecked leads remain"
                      : `Analyze the next ${aiTargets.length} visible raw lead${aiTargets.length === 1 ? "" : "s"} with post text`
                }
              >
                {aiRunning || aiLockedByOther || autoActive ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                {aiLockedByOther
                  ? "AI busy…"
                  : autoActive
                    ? `Auto-checking ${uncheckedCount} leads…`
                    : `Check ${aiTargets.length || 50} Lead${aiTargets.length === 1 ? "" : "s"}`}
              </Button>
              <p className="px-1 text-[11px] leading-snug text-muted-foreground lg:w-[210px]">
                {autoActive ? "Locked until under 50 left." : "Auto-runs at 50+ unchecked."}
              </p>
            </div>
          </div>
          {aiLockedByOther && (
            <div className="text-[11.5px] text-muted-foreground">
              {aiLock?.user_name ?? "Another user"} is running an AI batch right now — please wait.
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-[12.5px] text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {(error as Error).message}
        </div>
      )}

      {cacheQuery.isLoading && (
        <div className="text-[12.5px] text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading from database…
        </div>
      )}

      {/* Table */}
      <div className="crm-section-panel">
        <div className="glass-card overflow-hidden">
          <div className="max-h-[calc(100vh-340px)] overflow-auto">
            <table
              className="text-[12px] border-separate border-spacing-0 table-fixed w-full"
              style={{ minWidth: 1140 }}
            >
              <colgroup>
                <col style={{ width: 36 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 125 }} />
                <col style={{ width: 125 }} />
                <col style={{ width: 230 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: 86 }} />
                <col style={{ width: 176 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 60 }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  <th className="border-b border-border px-2 py-2">
                    <Checkbox
                      checked={
                        shownRows.length > 0 && shownRows.every((row) => selected.has(row.row_key))
                      }
                      onCheckedChange={(checked) => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (checked) {
                            for (const row of shownRows) next.add(row.row_key);
                          } else {
                            for (const row of shownRows) next.delete(row.row_key);
                          }
                          return next;
                        });
                      }}
                      aria-label="Select all visible"
                    />
                  </th>
                  {RAW_LEAD_COLUMNS.map((h) => (
                    <th
                      key={h}
                      className="border-b border-border px-2 py-2 text-left font-medium text-[10.5px] uppercase tracking-wide text-muted-foreground whitespace-normal leading-tight"
                    >
                      <SortHeader
                        label={h}
                        active={rawLeadSort.key === RAW_LEAD_SORT_BY_COLUMN[h]}
                        direction={rawLeadSort.direction}
                        onClick={() => toggleRawLeadSort(RAW_LEAD_SORT_BY_COLUMN[h])}
                      />
                    </th>
                  ))}
                  <th className="border-b border-border px-2 py-2 text-left font-medium text-[10.5px] uppercase tracking-wide text-muted-foreground whitespace-normal leading-tight">
                    <SortHeader
                      label="Assignment"
                      active={rawLeadSort.key === "assignment"}
                      direction={rawLeadSort.direction}
                      onClick={() => toggleRawLeadSort("assignment")}
                    />
                  </th>
                  <th className="border-b border-border px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {!cacheQuery.isLoading && visible.length === 0 && !error && (
                  <tr>
                    <td colSpan={12} className="text-center py-12 text-muted-foreground">
                      <Search className="h-5 w-5 mx-auto mb-2 opacity-50" />
                      No leads in this category. Try a different tab or refresh.
                    </td>
                  </tr>
                )}
                {shownRows.map((e) => {
                  const r = e.data;
                  const k = e.row_key;
                  const a = actions[k] || {};
                  const lv = effectiveLead(r, a);
                  const capturedAtPkt = formatCapturedDateTimePkt(e);
                  const mine = !!currentUserId && e.assigned_to === currentUserId;
                  const claimedByOther = !!e.assigned_to && e.assigned_to !== currentUserId;
                  const isSelected = selected.has(k);
                  return (
                    <tr
                      key={k}
                      className={cn(
                        "crm-data-row crm-motion align-top cursor-pointer",
                        isSelected
                          ? "crm-data-row-active"
                          : mine
                            ? "crm-data-row-active"
                            : claimedByOther
                              ? "crm-data-row-muted"
                              : "",
                      )}
                      onClick={() => setDetailFor(e)}
                    >
                      <td
                        className="border-b border-border px-2 py-2"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(k)}
                          aria-label="Select row"
                        />
                      </td>
                      <td className="border-b border-border px-2.5 py-2">
                        <div className="flex flex-col gap-1 items-start min-w-0">
                          <div className="font-medium truncate w-full" title={r["Account Name"]}>
                            {r["Account Name"] || "—"}
                          </div>
                          {e.duplicate_detected && (
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setDuplicateDetailsFor(e);
                              }}
                              className="inline-flex items-center rounded border border-destructive/30 bg-destructive/10 px-1 py-0.5 text-[9px] font-medium text-destructive whitespace-nowrap hover:bg-destructive/20 transition-colors"
                              title="Click to review duplicate match"
                            >
                              Duplicate Lead
                            </button>
                          )}
                        </div>
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2 truncate"
                        title={r["Sub Area / Neighborhood"]}
                      >
                        {r["Sub Area / Neighborhood"] || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2 text-[11.5px] text-muted-foreground truncate"
                        title={r["Posted Date & Time"]}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate">{r["Posted Date & Time"] || "—"}</span>
                          {isPostOlderThan24h(r["Posted Date & Time"]) && (
                            <span
                              aria-label="Old Post"
                              title="Posted more than 24 hours ago"
                              className="shrink-0 select-none pointer-events-none inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                            >
                              Old Post
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="border-b border-border px-2.5 py-2">
                        <div className="line-clamp-3 whitespace-pre-wrap" title={r["Post Text"]}>
                          {r["Post Text"] || "—"}
                        </div>
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <Select
                          value={lv || ""}
                          onValueChange={(v) => updateAction(k, { lead: v as "yes" | "no" })}
                        >
                          <SelectTrigger
                            className={cn(
                              "h-7 text-[11px]",
                              lv === "yes" && "bg-success/15 text-success border-success/30",
                              lv === "no" &&
                                "bg-destructive/15 text-destructive border-destructive/30",
                            )}
                          >
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="yes">Yes</SelectItem>
                            <SelectItem value="no">No</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        {r["Lead Link"] ? (
                          <a
                            href={r["Lead Link"]}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline text-[11px]"
                          >
                            <ExternalLink className="h-3 w-3" /> Open
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2 text-[11.5px] text-muted-foreground whitespace-nowrap"
                        title={capturedAtPkt}
                      >
                        {capturedAtPkt}
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2 text-[11.5px] truncate"
                        title={r["Account Area"]}
                      >
                        {r["Account Area"] || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2 text-[11.5px] truncate"
                        title={r["Incog Account"]}
                      >
                        {r["Incog Account"] || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td
                        className="border-b border-border px-2.5 py-2"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        {mine ? (
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary/15 text-primary text-[10.5px] font-medium border border-primary/30">
                              Assigned to you
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                              onClick={() => unassignFromSelf(e)}
                            >
                              <UserMinus className="mr-1 h-3.5 w-3.5" />
                              Unassign
                            </Button>
                          </div>
                        ) : claimedByOther ? (
                          <span
                            className="inline-flex items-center px-2 py-1 rounded-md bg-muted text-muted-foreground text-[10.5px] font-medium border border-border max-w-[160px] truncate"
                            title={assigneeNameFor(e.assigned_to) ?? "Claimed"}
                          >
                            {assigneeNameFor(e.assigned_to) ?? "Claimed"}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() => assignToSelf(e)}
                            disabled={!currentUserId}
                          >
                            Assign to myself
                          </Button>
                        )}
                      </td>
                      <td
                        className="border-b border-border px-2 py-2 text-center"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          onClick={() => setDetailFor(e)}
                          title="Open lead"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="crm-toolbar-panel flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11.5px] text-muted-foreground">
          {entries.length === 0 ? "No leads in this view" : "Showing results"}
          {visible.length !== entries.length && <> · {visible.length} match current filters</>}
        </div>
        <div className="flex items-center gap-2">
          {navigating && (
            <span className="inline-flex items-center text-[11.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Loading
            </span>
          )}
          {cacheQuery.isFetching && !navigating && (
            <span className="inline-flex items-center text-[11.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Updating
            </span>
          )}
          <Select
            value={String(pageSize)}
            onValueChange={(v) => {
              setPageSize(Number(v));
              resetPagination();
            }}
          >
            <SelectTrigger className="h-8 w-[88px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => navigateTo("next", null, 1)}
            disabled={currentPage === 1 || navigating || cacheQuery.isFetching}
          >
            « First
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              if (entries.length === 0) return;
              const firstEntry = entries[0];
              const prevCursor = { captured_at: firstEntry.captured_at, id: firstEntry.id };
              navigateTo("previous", prevCursor, currentPage - 1);
            }}
            disabled={currentPage === 1 || navigating || cacheQuery.isFetching}
          >
            Previous
          </Button>
          <div className="h-8 inline-flex items-center justify-center rounded-md border border-border bg-card px-3 text-[12px] font-medium tabular-nums min-w-[70px]">
            Page {currentPage} {totalPages ? `/ ${totalPages}` : ""}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              if (!cacheQuery.data?.hasMore || entries.length === 0) return;
              const lastEntry = entries[entries.length - 1];
              const nextCursor = { captured_at: lastEntry.captured_at, id: lastEntry.id };
              navigateTo("next", nextCursor, currentPage + 1);
            }}
            disabled={
              (!cacheQuery.data?.hasMore && currentPage >= (totalPages ?? Infinity)) ||
              navigating ||
              cacheQuery.isFetching
            }
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              if (!totalPages) return;
              navigateTo("last", "last", totalPages);
            }}
            disabled={
              !isUnfiltered ||
              !totalPages ||
              exactCountQuery.isFetching ||
              currentPage >= totalPages ||
              navigating ||
              cacheQuery.isFetching
            }
          >
            Last »
          </Button>
        </div>
      </div>

      {/* Ingest endpoint info */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Extension ingest endpoint</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-[12.5px]">
            <p className="text-muted-foreground">
              Paste this URL into the Nextdoor scraper extension webhook field. The extension keeps
              scraped leads in its local retry queue until this CRM endpoint accepts or dedupes
              them.
            </p>
            <div className="flex items-center gap-2">
              <Input value={nextdoorWebhookUrl} readOnly className="font-mono text-[12px]" />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(nextdoorWebhookUrl);
                  toast.success("Endpoint URL copied");
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-muted-foreground">
              Raw Leads uses database pagination for this table, which keeps Supabase usage lighter.
              Use Refresh or the pagination controls to pull accepted rows from the database.
              Duplicate Nextdoor post IDs or links are reported back to the extension as skipped.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setSettingsOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lead detail dialog */}
      {detailFor && (
        <LeadDetailDialog
          entry={detailFor}
          onClose={() => setDetailFor(null)}
          onLeadChange={async (lead) => {
            await updateAction(detailFor.row_key, { lead });
            toast.success(`Marked as ${lead === "yes" ? "Yes" : "No"}`);
          }}
          onNotFound={async () => {
            await updateAction(detailFor.row_key, { category: "not_found" });
            setDetailFor(null);
            toast.success("Moved to Number not found");
          }}
          onWrong={async () => {
            await updateAction(detailFor.row_key, { category: "wrong" });
            setDetailFor(null);
            toast.success("Marked as wrong post");
          }}
          onDuplicate={async () => {
            await updateAction(detailFor.row_key, { category: "duplicate" });
            setDetailFor(null);
            toast.success("Moved to Duplicate");
          }}
          onForward={async (phone, secondPhone) => {
            await updateAction(detailFor.row_key, { phone });
            setQualifyFor({ ...detailFor, phone });
            setQualifySecondPhone(secondPhone);
            setDetailFor(null);
          }}
        />
      )}

      {qualifyFor && (
        <QualifyDialog
          entry={qualifyFor}
          actorId={auth.user?.id ?? null}
          actorName={
            auth.profile?.full_name ?? auth.profile?.username ?? auth.profile?.email ?? null
          }
          actorRole={auth.primaryRole}
          initialSecondPhone={qualifySecondPhone}
          draft={qualifyDraft}
          onClose={() => {
            setQualifyFor(null);
            setQualifySecondPhone("");
            setQualifyDraft(null);
          }}
          onSent={async () => {
            // Clean up the related draft only AFTER the forward succeeds.
            if (auth.user?.id) {
              await deleteDraftForSource({
                userId: auth.user.id,
                draftId: qualifyDraft?.id ?? null,
                source_type: "raw_lead",
                source_lead_id: qualifyFor.id ?? null,
              });
            }
            qc.invalidateQueries({ queryKey: ["lead-drafts-count"] });
            await updateAction(qualifyFor.row_key, { category: "forwarded" });
            setQualifyFor(null);
            setQualifySecondPhone("");
            setQualifyDraft(null);
            toast.success("Forwarded to CS");
          }}
          onNotFound={async () => {
            await updateAction(qualifyFor.row_key, { category: "not_found" });
            setQualifyFor(null);
            setQualifySecondPhone("");
            setQualifyDraft(null);
            qc.invalidateQueries({ queryKey: ["lead-drafts-count"] });
            toast.success("Moved to Number not found");
          }}
        />
      )}

      {draftsOpen && (
        <Suspense fallback={null}>
          <DraftsDialog
            open={draftsOpen}
            onOpenChange={setDraftsOpen}
            filterSource="raw_lead"
            onOpenDraft={(draft) => {
              const snapshot = draft.form_data?.entrySnapshot as CacheEntry | undefined;
              if (!snapshot) {
                toast.error("This draft is missing its raw lead reference.");
                return;
              }
              setQualifyDraft(draft);
              setQualifySecondPhone("");
              setQualifyFor(snapshot);
            }}
          />
        </Suspense>
      )}

      {duplicateDetailsFor && (
        <Suspense fallback={null}>
          <RawLeadDuplicateDialog
            open={!!duplicateDetailsFor}
            onOpenChange={(open) => {
              if (!open) setDuplicateDetailsFor(null);
            }}
            currentLead={duplicateDetailsFor}
            onSendToDuplicateFilter={async () => {
              if (!duplicateDetailsFor) return;
              await updateAction(duplicateDetailsFor.row_key, { category: "duplicate" });
              toast.success("Moved to Duplicate");
              setDuplicateDetailsFor(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

// ── Lead detail dialog ────────────────────────────────────────────────────────
function LeadDetailDialog({
  entry,
  onClose,
  onNotFound,
  onWrong,
  onDuplicate,
  onForward,
  onLeadChange,
}: {
  entry: CacheEntry;
  onClose: () => void;
  onNotFound: () => void | Promise<void>;
  onWrong: () => void | Promise<void>;
  onDuplicate: () => void | Promise<void>;
  onForward: (phone: string, secondPhone: string) => void | Promise<void>;
  onLeadChange: (lead: "yes" | "no") => void | Promise<void>;
}) {
  const r = entry.data;
  const capturedAtPkt = formatCapturedDateTimePkt(entry);
  const [phone, setPhone] = useState(entry.phone ?? "");
  const [secondPhone, setSecondPhone] = useState("");
  const [showSecondPhone, setShowSecondPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [duplicateConfirmOpen, setDuplicateConfirmOpen] = useState(false);
  const checkDuplicate = useServerFn(checkDuplicatePhone);
  const phoneDigits = normalizePhone(phone);
  const secondPhoneDigits = normalizePhone(secondPhone);
  const duplicateQuery = useQuery({
    queryKey: ["duplicate-phone", phoneDigits],
    enabled: phoneDigits.length >= 7,
    queryFn: () => checkDuplicate({ data: { phone } }),
    staleTime: 15_000,
  });
  const secondDuplicateQuery = useQuery({
    queryKey: ["duplicate-phone", secondPhoneDigits],
    enabled: secondPhoneDigits.length >= 7,
    queryFn: () => checkDuplicate({ data: { phone: secondPhone } }),
    staleTime: 15_000,
  });
  const duplicateMatches = (duplicateQuery.data?.matches ?? []) as DuplicatePhoneMatch[];
  const secondDuplicateMatches = (secondDuplicateQuery.data?.matches ??
    []) as DuplicatePhoneMatch[];
  const hasDuplicate = duplicateMatches.length > 0 || secondDuplicateMatches.length > 0;
  const duplicatePreview = [
    ...duplicateMatches.map((match) => ({ source: "Primary number" as const, match })),
    ...secondDuplicateMatches.map((match) => ({ source: "Second number" as const, match })),
  ];

  async function handleNotFound() {
    setBusy(true);
    try {
      await onNotFound();
    } finally {
      setBusy(false);
    }
  }
  async function handleWrong() {
    setBusy(true);
    try {
      await onWrong();
    } finally {
      setBusy(false);
    }
  }
  async function handleDuplicate() {
    setBusy(true);
    try {
      await onDuplicate();
    } finally {
      setBusy(false);
    }
  }
  async function handleForward() {
    const p = phone.trim();
    if (entry.duplicate_detected) {
      const reason = entry.duplicate_reason || "Same post ID already exists in the system.";
      const ok = await confirmDialog({
        title: "Duplicate post detected",
        description: `${reason}\n\nForward anyway?`,
        confirmText: "Forward anyway",
        tone: "destructive",
      });
      if (!ok) return;
    }
    if (hasDuplicate) {
      setDuplicateConfirmOpen(true);
      return;
    }
    setBusy(true);
    try {
      await onForward(p, secondPhone.trim());
    } finally {
      setBusy(false);
    }
  }

  const isDirty = phone.trim() !== "" || secondPhone.trim() !== "";

  async function continueDespiteDuplicate() {
    const p = phone.trim();
    setDuplicateConfirmOpen(false);
    setBusy(true);
    try {
      await onForward(p, secondPhone.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) {
          void confirmDiscardUnsaved(isDirty).then((ok) => {
            if (ok) onClose();
          });
        }
      }}
    >
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Lead Details</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-[12.5px] min-w-0">
          {entry.duplicate_detected && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              <div className="font-semibold">Duplicate post detected</div>
              <div className="text-destructive/90">
                {entry.duplicate_reason || "This post ID already exists in the system."}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 min-w-0">
            <div className="min-w-0">
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Account Name
              </Label>
              <div className="text-foreground truncate" title={r["Account Name"]}>
                {r["Account Name"] || <span className="text-muted-foreground">—</span>}
              </div>
            </div>
            <div className="min-w-0">
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Sub Area
              </Label>
              <div className="text-foreground truncate" title={r["Sub Area / Neighborhood"]}>
                {r["Sub Area / Neighborhood"] || <span className="text-muted-foreground">—</span>}
              </div>
            </div>
            <div className="min-w-0">
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Account Area
              </Label>
              <div className="text-foreground truncate" title={r["Account Area"]}>
                {r["Account Area"] || <span className="text-muted-foreground">—</span>}
              </div>
            </div>
            <div className="min-w-0">
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Incog Account
              </Label>
              <div className="text-foreground truncate" title={r["Incog Account"]}>
                {r["Incog Account"] || <span className="text-muted-foreground">—</span>}
              </div>
            </div>
            <div className="min-w-0">
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Posted
              </Label>
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-foreground truncate" title={r["Posted Date & Time"]}>
                  {r["Posted Date & Time"] || <span className="text-muted-foreground">—</span>}
                </div>
                {isPostOlderThan24h(r["Posted Date & Time"]) && (
                  <span
                    aria-label="Old Post"
                    title="Posted more than 24 hours ago"
                    className="shrink-0 select-none pointer-events-none inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                  >
                    Old Post
                  </span>
                )}
              </div>
            </div>
            <div className="min-w-0">
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Captured Date and Time (PKT)
              </Label>
              <div className="text-foreground truncate" title={capturedAtPkt}>
                {capturedAtPkt}
              </div>
            </div>
          </div>

          <div>
            <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Post Text
            </Label>
            <div className="rounded-md border bg-muted/30 px-3 py-2 max-h-48 overflow-auto whitespace-pre-wrap">
              {r["Post Text"] || "—"}
            </div>
          </div>

          {r["Lead Link"] && (
            <a
              href={r["Lead Link"]}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-primary hover:underline text-[12px]"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open original post
            </a>
          )}

          <div className="pt-2 border-t grid grid-cols-2 gap-3 min-w-0">
            <div>
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Lead Status
              </Label>
              <Select
                value={effectiveLead(r, { lead: entry.lead }) || ""}
                onValueChange={(v) => onLeadChange(v as "yes" | "no")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Set Yes / No" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Phone Number
              </Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                placeholder="Phone from post / comments"
                autoFocus
              />
              {duplicateQuery.isFetching && (
                <p className="mt-1 text-[11px] text-muted-foreground">Checking duplicates...</p>
              )}
              {hasDuplicate && (
                <div className="mt-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11.5px] text-destructive">
                  Duplicate phone number detected in the last 48 hours
                  {duplicateMatches[0]?.customer_name
                    ? `: ${duplicateMatches[0].customer_name}`
                    : ""}
                </div>
              )}
            </div>
          </div>
          <div>
            {showSecondPhone ? (
              <>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                    Another Number
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      setSecondPhone("");
                      setShowSecondPhone(false);
                    }}
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Remove
                  </Button>
                </div>
                <Input
                  value={secondPhone}
                  onChange={(e) => setSecondPhone(formatPhoneInput(e.target.value))}
                  placeholder="Optional extra phone"
                />
                {secondDuplicateQuery.isFetching && (
                  <p className="mt-1 text-[11px] text-muted-foreground">Checking duplicates...</p>
                )}
                {secondDuplicateMatches.length > 0 && (
                  <div className="mt-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11.5px] text-destructive">
                    Duplicate second phone number detected in the last 48 hours
                    {secondDuplicateMatches[0]?.customer_name
                      ? `: ${secondDuplicateMatches[0].customer_name}`
                      : ""}
                  </div>
                )}
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => setShowSecondPhone(true)}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add another number
              </Button>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col-reverse sm:flex-row sm:justify-between gap-2">
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleNotFound} disabled={busy}>
              <PhoneOff className="h-4 w-4 mr-2" />
              Number not found
            </Button>
            <Button variant="outline" onClick={handleDuplicate} disabled={busy}>
              <Copy className="h-4 w-4 mr-2" />
              Duplicate
            </Button>
            <Button variant="ghost" onClick={handleWrong} disabled={busy}>
              Wrong post
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void confirmDiscardUnsaved(isDirty).then((ok) => {
                  if (ok) onClose();
                });
              }}
              disabled={busy}
            >
              Close
            </Button>
            <Button onClick={handleForward} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Forward
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      {duplicateConfirmOpen && (
        <Suspense fallback={null}>
          <DuplicateLeadDialog
            open={duplicateConfirmOpen}
            onOpenChange={setDuplicateConfirmOpen}
            matches={duplicatePreview}
            isConfirming={busy}
            onCancel={() => setDuplicateConfirmOpen(false)}
            onConfirm={() => void continueDespiteDuplicate()}
          />
        </Suspense>
      )}
    </Dialog>
  );
}

// ── Forward to CS dialog ──────────────────────────────────────────────────────
function QualifyDialog({
  entry,
  actorId,
  actorName,
  actorRole,
  initialSecondPhone,
  draft,
  onClose,
  onSent,
  onNotFound,
}: {
  entry: CacheEntry;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  initialSecondPhone: string;
  draft: LeadDraft | null;
  onClose: () => void;
  onSent: () => void;
  onNotFound: () => Promise<void> | void;
}) {
  const row = entry.data;
  const [busy, setBusy] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const qc = useQueryClient();
  const autoRephraseFn = useServerFn(autoRephraseLeadWithAi);

  async function send(values: LeadFormValues) {
    setBusy(true);
    try {
      const cleanedExtras = (values.extraNumbers || [])
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => formatPhone(p) || p);
      const { data: insertedLead, error } = await supabase
        .from("qualified_leads")
        .insert({
          customer_name: values.customerName,
          customer_number: formatPhone(values.customerNumber) || values.customerNumber,
          customer_number_2: cleanedExtras[0] ?? null,
          extra_numbers: cleanedExtras,
          post_text: values.exactCustomerText,
          context: values.context,
          service: values.service,
          pass_it_to: values.service,
          reference: values.reference,
          sub_area: values.area || null,
          main_area: values.area || null,
          original_lead_link: row["Lead Link"] || null,
          canonical_post_id: extractNextdoorPostId(row["Lead Link"]),
          canonical_lead_link: canonicalizeLeadLink(row["Lead Link"]),
          raw_lead_cache_id: entry.id,
          assigned_by: actorId,
          created_by: actorId,
          cs_status: "new",
          is_landline: values.isLandline,
          is_important: values.isImportant,
          pinned_important: values.isImportant,
          submitted_by_role: actorRole,
        } as never)
        .select("id")
        .maybeSingle();
      if (error) throw error;

      if (insertedLead?.id) {
        void syncLeadToGoogleSheet("INSERT", {
          id: insertedLead.id,
          customer_name: values.customerName,
          customer_number: formatPhone(values.customerNumber) || values.customerNumber,
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
          console.error("[Auto-rephrase] Failed for forwarded lead:", insertedLead.id, err);
        });
      }

      if (actorId) {
        await supabase.from("activity_logs").insert({
          actor_id: actorId,
          actor_name: actorName,
          actor_role: actorRole,
          action: "raw.forwarded_to_cs",
          entity_type: "qualified_lead",
          metadata: {
            customer_name: values.customerName,
            customer_number: formatPhone(values.customerNumber) || values.customerNumber,
            area: values.area || null,
            reference: values.reference,
          },
        });
      }
      onSent();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDraft(values: LeadFormValues) {
    if (!actorId) {
      toast.error("You must be signed in to save a draft.");
      return;
    }
    try {
      // Auto-claim the raw lead for the current user if it is still
      // unassigned. Never overwrite another user's existing assignment.
      let claimedAt: string | null = entry.assigned_myself_at;
      let claimedBy: string | null = entry.assigned_to;
      if (!entry.assigned_to) {
        const now = new Date().toISOString();
        const { data: claimed, error: claimErr } = await supabase
          .from(TABLE)
          .update({
            assigned_to: actorId,
            assigned_myself_at: now,
          } as RawLeadCacheUpdate)
          .eq("row_key", entry.row_key)
          .is("assigned_to", null)
          .select("assigned_to, assigned_myself_at")
          .maybeSingle();
        if (claimErr) throw claimErr;
        if (!claimed) {
          toast.error("This lead was just claimed by another user. Please refresh.");
          return;
        }
        claimedBy = actorId;
        claimedAt = now;
      } else if (entry.assigned_to !== actorId) {
        // Assigned to someone else — do not overwrite, but still save the draft
        // under the current user's account (drafts are per-user).
      }

      const snapshotEntry: CacheEntry = {
        ...entry,
        assigned_to: claimedBy,
        assigned_myself_at: claimedAt,
      };

      await saveDraft({
        id: draft?.id ?? null,
        source_type: "raw_lead",
        source_lead_id: entry.id ?? null,
        created_by: actorId,
        form_data: {
          customerName: values.customerName,
          customerNumber: values.customerNumber,
          extraNumbers: values.extraNumbers ?? [],
          area: values.area,
          service: values.service,
          context: values.context,
          exactCustomerText: values.exactCustomerText,
          reference: values.reference,
          isImportant: values.isImportant,
          originalLeadLink: values.originalLeadLink ?? null,
          entrySnapshot: snapshotEntry,
        },
      });
      toast.success("Draft saved successfully.");
      setIsDirty(false);
      // Refresh cache/counts so the lead now appears under "Assigned Myself".
      qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
      qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
      qc.invalidateQueries({ queryKey: ["lead-drafts-count"] });
    } catch (e) {
      toast.error(friendlyError(e));
    }
  }

  const draftData = draft?.form_data ?? null;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          void confirmDiscardUnsaved(isDirty).then((ok) => {
            if (ok) onClose();
          });
        }
      }}
    >
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{draft ? "Forward to CS (Draft)" : "Forward to CS"}</DialogTitle>
        </DialogHeader>
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <LeadForm
            title="Raw lead to CS"
            submitLabel="Send"
            forwardedBy={actorName ?? "Current user"}
            showAttachments={false}
            areaRequired
            referenceMode="auto-scraping"
            submitting={busy}
            onDirtyChange={setIsDirty}
            initialValues={{
              customerName:
                (draftData?.customerName as string | undefined) ?? row["Account Name"] ?? "",
              customerNumber:
                (draftData?.customerNumber as string | undefined) ??
                formatPhoneInput(entry.phone ?? ""),
              extraNumbers:
                (draftData?.extraNumbers as string[] | undefined) ??
                (initialSecondPhone ? [formatPhoneInput(initialSecondPhone)] : []),
              area:
                (draftData?.area as string | undefined) ??
                row["Account Area"] ??
                row["Sub Area / Neighborhood"] ??
                "",
              service: (draftData?.service as string | undefined) ?? "",
              context: (draftData?.context as string | undefined) ?? "",
              exactCustomerText:
                (draftData?.exactCustomerText as string | undefined) ?? row["Post Text"] ?? "",
              reference: draftData?.reference as string | undefined,
              isImportant: (draftData?.isImportant as boolean | undefined) ?? false,
            }}
            onCancel={onClose}
            onSubmit={send}
            onSaveDraft={handleSaveDraft}
            onNumberNotFound={async () => {
              if (actorId) {
                await deleteDraftForSource({
                  userId: actorId,
                  draftId: draft?.id ?? null,
                  source_type: "raw_lead",
                  source_lead_id: entry.id ?? null,
                });
              }
              await onNotFound();
            }}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
