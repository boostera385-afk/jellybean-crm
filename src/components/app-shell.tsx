import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Table2,
  Map,
  BarChart3,
  LineChart,
  ScrollText,
  Settings,
  Headphones,
  LogOut,
  Globe,
  ShieldCheck,
  Send,
  PieChart,
  KeyRound,
  MessageSquare,
  Menu,
  FileSpreadsheet,
  BellRing,
  Users,
  MapPinned,
} from "lucide-react";

import { CrmUpdatesNotifier } from "@/components/crm-updates-notifier";
import { LeadReminderNotifier } from "@/components/lead-reminder-notifier";
import { CrispMessageNotifier } from "@/components/crisp-message-notifier";
import { CrispVisitorAlerts } from "@/components/crisp-visitor-alerts";

import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import type { AppRole, AuthState } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { useClockSkew } from "@/hooks/use-clock-skew";
import { ChangePasswordDialog } from "@/components/auth/change-password-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useState } from "react";
import { useCrispUnread } from "@/hooks/use-crisp-unread";
import { usePendingReminders } from "@/hooks/use-pending-reminders";

type Item = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string;
};

const CRISP_ITEM: Item = {
  to: "/app/crisp-chat",
  label: "Crisp Chat",
  icon: MessageSquare,
  shortcut: "C",
};

const PENDING_ITEM: Item = {
  to: "/app/pending-leads",
  label: "Pending leads",
  icon: BellRing,
};

const SERVICE_AREA_BASE_ITEM: Item = {
  to: "/app/service-area-base",
  label: "Service/Area Base",
  icon: MapPinned,
};

// Optional feature entries an admin can grant per user from
// Settings -> Feature Access. Keyed by the feature flag name.
const FEATURE_NAV_ITEMS: Record<string, Item> = {
  analytics: { to: "/app/analytics", label: "Analytics", icon: LineChart },
};

const ADMIN: Item[] = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, shortcut: "D" },
  { to: "/app/raw-leads", label: "Raw Leads", icon: Table2, shortcut: "L" },
  { to: "/app/cs-leads", label: "CS Pipeline", icon: Headphones, shortcut: "P" },
  { to: "/app/pending-leads", label: "Pending leads", icon: BellRing },
  { to: "/app/crisp-chat", label: "Crisp Chat", icon: MessageSquare, shortcut: "C" },
  { to: "/app/browser-profiles", label: "Browser Profiles", icon: Globe, shortcut: "B" },
  { to: "/app/map", label: "Map", icon: Map, shortcut: "M" },
  { to: "/app/analytics", label: "Analytics", icon: LineChart, shortcut: "N" },
  { to: "/app/reports", label: "Reports", icon: BarChart3, shortcut: "R" },
  { to: "/app/lead-assignment", label: "Lead Assignment", icon: PieChart },
  { to: "/app/logs", label: "Activity", icon: ScrollText, shortcut: "G" },
  { to: "/app/google-sheets", label: "Google Sheets", icon: FileSpreadsheet, shortcut: "H" },
  SERVICE_AREA_BASE_ITEM,
  { to: "/app/settings", label: "Settings", icon: Settings, shortcut: "S" },
];

const SCRAPING: Item[] = [
  { to: "/app/raw-leads", label: "Raw Leads", icon: Table2 },
  { to: "/app/browser-profiles", label: "Browser Profiles", icon: Globe },
];

const MATURING: Item[] = [
  { to: "/app/raw-leads", label: "Raw Leads", icon: Table2 },
  { to: "/app/forwarded-leads", label: "Forwarded Leads", icon: Headphones },
  { to: "/app/submit-lead", label: "Manual Lead", icon: Send },
];

const CS: Item[] = [
  { to: "/app/cs-leads", label: "Dashboard", icon: LayoutDashboard },
  PENDING_ITEM,
  CRISP_ITEM,
];

const CS_ADMIN_ITEMS: Item[] = [
  { to: "/app/cs-leads", label: "CS Pipeline", icon: Headphones },
  PENDING_ITEM,
  CRISP_ITEM,
  { to: "/app/lead-assignment", label: "Lead Assignment", icon: PieChart },
  SERVICE_AREA_BASE_ITEM,
  { to: "/app/settings", label: "Users", icon: Users },
];

const ACC_HANDLER: Item[] = [
  { to: "/app/map", label: "Map", icon: Map, shortcut: "M" },
  { to: "/app/browser-profiles", label: "Browser Profiles", icon: Globe, shortcut: "B" },
  { to: "/app/raw-leads", label: "Raw Leads", icon: Table2, shortcut: "L" },
  { to: "/app/forwarded-leads", label: "Forwarded Leads", icon: Headphones },
  { to: "/app/submit-lead", label: "Manual Lead", icon: Send },
];

const SUBMITTER: Item[] = [
  { to: "/app/submit-lead", label: "Submit Lead", icon: Send },
  { to: "/app/forwarded-leads", label: "Forwarded Leads", icon: Headphones },
];

const ADMIN_FULL: Item[] = [
  ...ADMIN.slice(0, 3),
  { to: "/app/forwarded-leads", label: "Forwarded Leads", icon: Headphones },
  { to: "/app/submit-lead", label: "Manual Lead", icon: Send },
  ...ADMIN.slice(3),
];

const SUB_ADMIN: Item[] = ADMIN_FULL.filter(
  (item) =>
    item.to !== "/app/cs-leads" &&
    item.to !== "/app/pending-leads" &&
    item.to !== "/app/service-area-base" &&
    item.to !== "/app/logs" &&
    item.to !== "/app/crisp-chat",
).map((item) => (item.to === "/app/settings" ? { ...item, label: "Users", icon: Users } : item));

function itemsForRole(role: AppRole | null): Item[] {
  if (role === "admin") return ADMIN_FULL;
  if (role === "sub_admin") return SUB_ADMIN;
  if (role === "scraping") return SCRAPING;
  if (role === "maturing") return MATURING;
  if (role === "cs") return CS;
  if (role === "cs_admin") return CS_ADMIN_ITEMS;
  if (role === "acc_handler") return ACC_HANDLER;
  if (role === "facebook" || role === "seo") return SUBMITTER;
  return [];
}

// Append any granted optional features that the role doesn't already surface.
function withGrantedFeatures(items: Item[], features: string[]): Item[] {
  const present = new Set(items.map((item) => item.to));
  const extra = features
    .map((feature) => FEATURE_NAV_ITEMS[feature])
    .filter((item): item is Item => !!item && !present.has(item.to));
  return extra.length > 0 ? [...items, ...extra] : items;
}

function navigationGroupsForRole(
  role: AppRole | null,
  features: string[],
): Array<{ label: string; items: Item[] }> {
  const available = withGrantedFeatures(itemsForRole(role), features);
  if (role !== "admin" && role !== "sub_admin") return [{ label: "Workspace", items: available }];

  const groups = [
    {
      label: "Operations",
      paths: [
        "/app",
        "/app/raw-leads",
        "/app/forwarded-leads",
        "/app/submit-lead",
        "/app/browser-profiles",
        "/app/map",
      ],
    },
    {
      label: "Customer service",
      paths: ["/app/cs-leads", "/app/pending-leads", "/app/crisp-chat", "/app/lead-assignment"],
    },
    { label: "Intelligence", paths: ["/app/analytics", "/app/reports"] },
    {
      label: "Administration",
      paths: ["/app/logs", "/app/google-sheets", "/app/service-area-base", "/app/settings"],
    },
  ];
  return groups
    .map((group) => ({
      ...group,
      items: available.filter((item) => group.paths.includes(item.to)),
    }))
    .filter((group) => group.items.length > 0);
}

function initials(name?: string | null, email?: string | null) {
  const src = name?.trim() || email?.trim() || "?";
  const parts = src.split(/[\s.@]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || src[0]!.toUpperCase();
}

function roleLabel(role: AppRole | null) {
  if (role === "sub_admin") return "Sub-admin";
  return role?.replace(/_/g, " ") ?? "no role";
}

export function AppShell({ auth, children }: { auth: AuthState; children: React.ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigationGroups = navigationGroupsForRole(auth.primaryRole, auth.features);
  const displayName = auth.profile?.full_name || auth.user?.email || "-";
  const skewSeconds = useClockSkew();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { unreadCount: crispUnreadCount, hasUnread: hasCrispUnread } = useCrispUnread(
    auth.primaryRole === "admin" || auth.primaryRole === "cs" || auth.primaryRole === "cs_admin",
  );
  const { hasPending: hasPendingReminders } = usePendingReminders(
    auth.primaryRole === "admin" || auth.primaryRole === "cs" || auth.primaryRole === "cs_admin",
  );

  useRealtimeSync(auth.primaryRole);

  return (
    <div className="crm-app-shell flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="crm-sidebar-shell relative hidden w-[252px] shrink-0 text-sidebar-foreground lg:flex flex-col h-full">
        <div className="shrink-0 border-b border-sidebar-border px-5 py-5">
          <div className="flex items-center justify-start gap-2.5">
            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-[15px] border border-border bg-card shadow-sm">
              <img src="/favicon.svg?v=2" alt="JellyBean" className="h-10 w-10 object-contain" />
            </div>
            <div className="leading-tight">
              <div className="text-[15px] font-bold tracking-[-0.025em] text-sidebar-accent-foreground">
                JellyBean
              </div>
              <div className="mt-1 text-[10px] font-semibold tracking-[0.12em] uppercase text-sidebar-foreground/60">
                Operations CRM
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 min-h-0 px-3 py-4 space-y-1 overflow-y-auto overscroll-contain">
          {navigationGroups.map((group) => (
            <div key={group.label} className="space-y-1 pb-3">
              <div className="px-3 pb-2 pt-1 text-[10px] uppercase tracking-[0.14em] text-sidebar-foreground/55 font-bold">
                {group.label}
              </div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active =
                  item.to === "/app"
                    ? path === "/app" || path === "/app/"
                    : path.startsWith(item.to);
                const isCrispItem = item.to === "/app/crisp-chat";
                const shouldBlinkCrisp = isCrispItem && hasCrispUnread;

                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    title={item.label}
                    className={cn(
                      "group crm-motion relative flex h-10 items-center justify-start gap-3 px-3 rounded-xl text-[13px] tracking-[-0.005em]",
                      shouldBlinkCrisp &&
                        "animate-pulse bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.35)]",
                      active
                        ? "crm-sidebar-active font-semibold"
                        : !shouldBlinkCrisp &&
                            "text-sidebar-foreground font-medium hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <div className="relative flex items-center justify-center">
                      <Icon
                        className={cn(
                          "h-[16px] w-[16px] crm-motion",
                          active
                            ? "text-inherit"
                            : shouldBlinkCrisp
                              ? "text-emerald-300"
                              : "text-sidebar-foreground/70 group-hover:text-sidebar-accent-foreground",
                        )}
                      />
                    </div>
                    <span
                      className={cn(
                        "flex-1 truncate",
                        shouldBlinkCrisp && "font-semibold text-emerald-200",
                      )}
                    >
                      {item.label}
                    </span>
                    {isCrispItem && crispUnreadCount > 0 && (
                      <span className="inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500 text-white shadow-sm shrink-0">
                        {crispUnreadCount}
                      </span>
                    )}
                    {item.to === "/app/pending-leads" && hasPendingReminders && (
                      <span
                        aria-label="Pending reminders"
                        className="h-2 w-2 shrink-0 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_8px_rgba(250,204,21,0.75)]"
                      />
                    )}
                    {item.shortcut && !shouldBlinkCrisp && (
                      <kbd
                        className={cn(
                          "inline-flex crm-motion opacity-0 group-hover:opacity-100 text-[10px] px-1.5 py-0.5 rounded font-mono",
                          active
                            ? "bg-white/15 text-inherit"
                            : "bg-muted text-sidebar-foreground/60",
                        )}
                      >
                        {item.shortcut}
                      </kbd>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="px-3 pb-3 flex flex-col gap-1.5">
          <ThemeToggle className="group crm-motion relative flex h-10 w-full items-center justify-start gap-3 px-3 rounded-xl text-[13px] tracking-[-0.005em] text-sidebar-foreground font-medium hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus:ring-0 focus:ring-offset-0" />
        </div>
        <div className="mt-auto p-3">
          <div className="flex items-center justify-start gap-2.5 rounded-2xl bg-sidebar-accent/70 border border-sidebar-border shadow-sm p-2.5 overflow-hidden">
            <div className="h-9 w-9 shrink-0 rounded-xl bg-primary grid place-items-center text-[12px] font-bold text-primary-foreground shadow-sm">
              {initials(auth.profile?.full_name, auth.user?.email)}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <div className="text-[13px] font-bold tracking-tight truncate text-sidebar-accent-foreground leading-none mb-1.5">
                {displayName}
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-sidebar-foreground capitalize flex items-center gap-1.5 leading-none">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate">{roleLabel(auth.primaryRole)}</span>
              </div>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={() => setPasswordDialogOpen(true)}
                title="Change Password"
                aria-label="Change Password"
                className="crm-motion h-8 w-8 grid place-items-center rounded-lg text-sidebar-foreground hover:bg-background/50 hover:text-sidebar-accent-foreground transition-colors"
              >
                <KeyRound className="h-4 w-4" />
              </button>
              <button
                onClick={() => void auth.signOut()}
                title="Sign out"
                aria-label="Sign out"
                className="crm-motion h-8 w-8 grid place-items-center rounded-lg text-sidebar-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="crm-sidebar-shell flex h-full w-[min(86vw,320px)] flex-col border-0 p-0 text-sidebar-foreground"
        >
          <SheetHeader className="border-b border-sidebar-border px-5 py-5 text-left">
            <SheetTitle className="flex items-center gap-2.5 text-sidebar-accent-foreground">
              <img src="/favicon.svg?v=2" alt="" className="h-10 w-10 object-contain" />
              <span>JellyBean CRM</span>
            </SheetTitle>
          </SheetHeader>
          <nav aria-label="Main navigation" className="flex-1 overflow-y-auto space-y-1 px-3 py-4">
            {navigationGroups.map((group) => (
              <div key={group.label} className="space-y-1 pb-3">
                <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-sidebar-foreground/55">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    item.to === "/app"
                      ? path === "/app" || path === "/app/"
                      : path.startsWith(item.to);
                  const isCrispItem = item.to === "/app/crisp-chat";
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileNavOpen(false)}
                      className={cn(
                        "flex h-11 items-center gap-3 rounded-xl px-3 text-[14px] font-medium",
                        active
                          ? "crm-sidebar-active"
                          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {isCrispItem && crispUnreadCount > 0 && (
                        <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {crispUnreadCount}
                        </span>
                      )}
                      {item.to === "/app/pending-leads" && hasPendingReminders && (
                        <span
                          aria-label="Pending reminders"
                          className="h-2 w-2 shrink-0 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_8px_rgba(250,204,21,0.75)]"
                        />
                      )}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="border-t border-sidebar-border p-3 space-y-1.5">
            <ThemeToggle className="flex h-11 w-full items-center justify-start gap-3 rounded-xl px-3 text-[14px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
            <button
              type="button"
              onClick={() => void auth.signOut()}
              className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[14px] text-sidebar-foreground hover:bg-destructive/15 hover:text-destructive"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </SheetContent>
      </Sheet>
      <main className="flex-1 min-w-0 h-full overflow-y-auto overflow-x-hidden bg-background">
        <div className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-xl lg:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="inline-flex h-10 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-foreground hover:bg-muted"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
            <span>Menu</span>
          </button>
          <img src="/favicon.svg?v=2" alt="JellyBean" className="h-8 w-8 object-contain" />
          <ThemeToggle className="h-10 w-10 p-0 [&>span]:hidden" />
        </div>
        {skewSeconds !== null && (
          <div className="m-4 p-3 rounded-md border border-warning/40 bg-warning/10 text-warning-foreground text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 animate-fade-in">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 font-semibold text-[13px]">
                <span>System Clock Out of Sync</span>
              </div>
              <p className="text-xs leading-relaxed opacity-90">
                Your computer's clock is out of sync with our servers by about{" "}
                <strong>{Math.round(Math.abs(skewSeconds) / 60)} minutes</strong>. This causes
                security checks to fail and will trigger automatic logout.
              </p>
            </div>
            <div className="shrink-0 text-xs font-semibold bg-warning/20 px-3 py-1.5 rounded border border-warning/40">
              Enable "Set time automatically" in Date & Time Settings
            </div>
          </div>
        )}
        {children}
      </main>
      <ChangePasswordDialog
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
        userEmail={auth.user?.email ?? auth.profile?.email ?? null}
      />
      <CrmUpdatesNotifier />
      <LeadReminderNotifier />
      <CrispMessageNotifier />
      <CrispVisitorAlerts />
    </div>
  );
}
