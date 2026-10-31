import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/crm-lite";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Download,
  Rocket,
  Trash2,
  Search,
  Globe,
  Plus,
  Info,
  Upload,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  CalendarCheck,
  CalendarRange,
  Pencil,
  RefreshCw,
  Star,
  Layers,
  FolderPlus,
  X,
  Check,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import { launchIncognitonProfile } from "@/lib/incogniton";
import { pktDayKey, pktNextMidnight, pktTodayKey } from "@/lib/timezone";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/app/browser-profiles")({
  head: () => ({
    meta: [
      { title: "Browser Profiles \u00b7 JellyBean" },
      { name: "description", content: "Manage browser profiles for JellyBean account operations." },
      { property: "og:title", content: "Browser Profiles \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Manage browser profiles for JellyBean account operations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

type LaunchHistoryEntry = { at: string; by: string | null };
type ProfilePriority = "none" | "first" | "second";
type ProfileView =
  "all" | "first" | "second" | "other" | "launched_today" | "groups" | "performance";
type PerformancePreset = "today" | "week" | "month" | "custom";
type ProfilePerformanceRow = {
  profile_id: string;
  profile_name: string;
  incogniton_profile_id: string;
  account_area: string | null;
  profile_priority: ProfilePriority;
  launch_count: number;
  scraped_posts: number;
  forwarded: number;
  delivered: number;
  cx_interested: number;
  top_service: string | null;
};
type IncognitonProfileInsert = Database["public"]["Tables"]["incogniton_profiles"]["Insert"];
type IncognitonProfileUpdate = Database["public"]["Tables"]["incogniton_profiles"]["Update"];
type FileFormat = "xlsx" | "csv";
type ProfileSheetRow = {
  "account name": string;
  "profile id": string;
  "account area": string;
  latitude: string | number;
  longitude: string | number;
};

type Profile = {
  id: string;
  profile_name: string;
  incogniton_profile_id: string;
  group_name: string | null;
  last_launched_at: string | null;
  launched_by_name: string | null;
  launched_by_email: string | null;
  created_at: string;
  latitude: number | null;
  longitude: number | null;
  account_area: string | null;
  launch_history: LaunchHistoryEntry[] | null;
  notes: string | null;
  is_active: boolean;
  profile_priority: ProfilePriority;
};

type SortDirection = "asc" | "desc";
type ProfileSortKey =
  "profile_name" | "profile_id" | "group" | "account_area" | "geo" | "added_date" | "last_launched";
type ProfileSort = { key: ProfileSortKey; direction: SortDirection };

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function profileSortValue(profile: Profile, key: ProfileSortKey) {
  switch (key) {
    case "profile_name":
      return profile.profile_name;
    case "profile_id":
      return profile.incogniton_profile_id;
    case "group":
      return profile.group_name ?? "";
    case "account_area":
      return profile.account_area ?? "";
    case "geo":
      return profile.latitude != null && profile.longitude != null
        ? `${profile.latitude.toFixed(6)},${profile.longitude.toFixed(6)}`
        : "";
    case "added_date":
      return new Date(profile.created_at).getTime() || 0;
    case "last_launched":
      return profile.last_launched_at ? new Date(profile.last_launched_at).getTime() || 0 : 0;
  }
}

function compareProfiles(a: Profile, b: Profile, sort: ProfileSort) {
  const av = profileSortValue(a, sort.key);
  const bv = profileSortValue(b, sort.key);
  const result =
    typeof av === "number" && typeof bv === "number"
      ? av - bv
      : compareText(String(av), String(bv));
  return sort.direction === "asc" ? result : -result;
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
      className="inline-flex w-full items-center justify-between gap-1 text-left font-medium text-muted-foreground hover:text-foreground"
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      <Icon className="h-3 w-3 shrink-0" />
    </button>
  );
}

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Browser Profiles"
        description="Add your Incogniton profile IDs here and launch them with one click."
      />
      <PageBody className="!pt-5">
        <RoleGate
          allow={["admin", "sub_admin", "scraping", "acc_handler"]}
          current={auth.primaryRole}
        >
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const qc = useQueryClient();
  const auth = useAuth();
  const [query, setQuery] = useState("");
  const [addedDateFilter, setAddedDateFilter] = useState("");
  const [profileSort, setProfileSort] = useState<ProfileSort>({
    key: "added_date",
    direction: "desc",
  });
  const [addOpen, setAddOpen] = useState(false);
  const [editingFor, setEditingFor] = useState<Profile | null>(null);
  const [profileView, setProfileView] = useState<ProfileView>("all");
  const [todayKey, setTodayKey] = useState(pktTodayKey);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<Profile | null>(null);
  const [noteFor, setNoteFor] = useState<Profile | null>(null);
  const [howToOpen, setHowToOpen] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleRollover = () => {
      const delay = Math.max(1_000, pktNextMidnight().getTime() - Date.now() + 250);
      timer = setTimeout(() => {
        setTodayKey(pktTodayKey());
        scheduleRollover();
      }, delay);
    };
    scheduleRollover();
    return () => clearTimeout(timer);
  }, []);

  const profiles = useQuery({
    queryKey: ["incog_profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("incogniton_profiles")
        .select(
          "id, profile_name, incogniton_profile_id, group_name, account_area, latitude, longitude, last_launched_at, launched_by_name, launched_by_email, created_at, launch_history, notes, is_active, profile_priority",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Profile[];
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const groups = useMemo(
    () =>
      Array.from(
        new Set((profiles.data ?? []).map((p) => p.group_name).filter((g): g is string => !!g)),
      ).sort(),
    [profiles.data],
  );

  const filtered = useMemo(() => {
    if (profileView === "performance") return [];
    const q = query.trim().toLowerCase();
    const list = (profiles.data ?? []).filter((p) => {
      if (addedDateFilter && dateKey(p.created_at) !== addedDateFilter) return false;
      if (profileView === "first" && p.profile_priority !== "first") return false;
      if (profileView === "second" && p.profile_priority !== "second") return false;
      if (
        profileView === "other" &&
        (p.profile_priority === "first" || p.profile_priority === "second")
      ) {
        return false;
      }
      if (profileView === "launched_today" && pktDayKey(p.last_launched_at) !== todayKey) {
        return false;
      }
      if (!q) return true;
      return (
        p.profile_name.toLowerCase().includes(q) ||
        p.incogniton_profile_id.toLowerCase().includes(q) ||
        (p.account_area ?? "").toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => compareProfiles(a, b, profileSort));
  }, [addedDateFilter, profileSort, profileView, profiles.data, query, todayKey]);

  const profileCounts = useMemo(() => {
    const all = profiles.data ?? [];
    const counts = { all: all.length, first: 0, second: 0, other: 0, launchedToday: 0 };
    for (const profile of all) {
      if (profile.profile_priority === "first") counts.first += 1;
      else if (profile.profile_priority === "second") counts.second += 1;
      else counts.other += 1;
      if (pktDayKey(profile.last_launched_at) === todayKey) counts.launchedToday += 1;
    }
    return counts;
  }, [profiles.data, todayKey]);

  const toggleProfileSort = (key: ProfileSortKey) => {
    setProfileSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "added_date" || key === "last_launched" ? "desc" : "asc" },
    );
  };

  useEffect(() => {
    const validIds = new Set((profiles.data ?? []).map((profile) => profile.id));
    setSelectedProfileIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [profiles.data]);

  const selectedProfiles = useMemo(() => {
    return (profiles.data ?? []).filter((profile) => selectedProfileIds.has(profile.id));
  }, [profiles.data, selectedProfileIds]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((profile) => selectedProfileIds.has(profile.id));

  function toggleProfileSelection(profileId: string, checked: boolean) {
    setSelectedProfileIds((current) => {
      const next = new Set(current);
      if (checked) next.add(profileId);
      else next.delete(profileId);
      return next;
    });
  }

  function toggleAllFiltered(checked: boolean) {
    setSelectedProfileIds((current) => {
      const next = new Set(current);
      for (const profile of filtered) {
        if (checked) next.add(profile.id);
        else next.delete(profile.id);
      }
      return next;
    });
  }

  async function launch(p: Profile) {
    toast.loading("Launching profile…", { id: "launch" });
    try {
      await launchIncognitonProfile(p.incogniton_profile_id);
      const user = auth.user;
      const who = user?.user_metadata?.full_name ?? user?.email?.split("@")[0] ?? "Unknown";
      const nowIso = new Date().toISOString();
      const prevHistory = Array.isArray(p.launch_history) ? p.launch_history : [];
      const nextHistory = [{ at: nowIso, by: who }, ...prevHistory].slice(0, 100);
      supabase
        .from("incogniton_profiles")
        .update({
          last_launched_at: nowIso,
          launched_by_name: who,
          launched_by_email: user?.email ?? null,
          launch_history: nextHistory as Json,
        })
        .eq("id", p.id)
        .then(() => qc.invalidateQueries({ queryKey: ["incog_profiles"] }));
      toast.success("Launch command sent ✓ — Incogniton should open the profile now.", {
        id: "launch",
      });
    } catch (e) {
      toast.error(
        "Could not launch. Make sure: (1) Incogniton is open, (2) the Bridge is installed on this PC. See README.txt in the bridge folder.",
        { id: "launch", duration: 6000 },
      );
    }
  }

  async function remove(p: Profile) {
    if (!confirm(`Delete profile "${p.profile_name}"? This only removes it from this CRM.`)) return;
    const { error } = await supabase.from("incogniton_profiles").delete().eq("id", p.id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["incog_profiles"] });
  }

  const [downloadingBridge, setDownloadingBridge] = useState(false);
  const [downloadingExtension, setDownloadingExtension] = useState(false);

  const handleDownloadBridge = async () => {
    setDownloadingBridge(true);
    try {
      const { data, error } = await supabase.storage
        .from("crm-downloads")
        .createSignedUrl("incogniton-bridge.zip", 60 * 10);

      if (error || !data?.signedUrl) {
        toast.error("Failed to generate download link for Bridge.");
        return;
      }
      window.open(data.signedUrl, "_blank");
    } catch (e) {
      toast.error("An unexpected error occurred.");
    } finally {
      setDownloadingBridge(false);
    }
  };

  const handleDownloadExtension = async () => {
    setDownloadingExtension(true);
    try {
      const { data, error } = await supabase.storage
        .from("crm-downloads")
        .createSignedUrl("scraping-extension.zip", 60 * 10);

      if (error || !data?.signedUrl) {
        toast.error("Failed to generate download link for Extension.");
        return;
      }
      window.open(data.signedUrl, "_blank");
    } catch (e) {
      toast.error("An unexpected error occurred.");
    } finally {
      setDownloadingExtension(false);
    }
  };

  async function removeSelected() {
    const ids = [...selectedProfileIds];
    if (ids.length === 0) return;
    const names = selectedProfiles
      .slice(0, 5)
      .map((profile) => profile.profile_name)
      .join(", ");
    const extra = ids.length > 5 ? ` and ${ids.length - 5} more` : "";
    if (
      !confirm(
        `Delete ${ids.length} selected profile${ids.length === 1 ? "" : "s"}?\n\n${names}${extra}`,
      )
    ) {
      return;
    }
    const { error } = await supabase.from("incogniton_profiles").delete().in("id", ids);
    if (error) return toast.error(error.message);
    toast.success(`Deleted ${ids.length} profile${ids.length === 1 ? "" : "s"}`);
    setSelectedProfileIds(new Set());
    qc.invalidateQueries({ queryKey: ["incog_profiles"] });
  }

  function statusOf(p: Profile) {
    if (!p.last_launched_at) return "Not launched yet";
    return Date.now() - new Date(p.last_launched_at).getTime() < 30 * 60 * 1000
      ? "Launched recently"
      : "Not launched recently";
  }

  async function toggleActive(p: Profile) {
    const nextState = !p.is_active;
    qc.setQueryData(["incog_profiles"], (old: Profile[] | undefined) => {
      if (!old) return old;
      return old.map((profile) =>
        profile.id === p.id ? { ...profile, is_active: nextState } : profile,
      );
    });

    const { error } = await supabase
      .from("incogniton_profiles")
      .update({ is_active: nextState })
      .eq("id", p.id);
    if (error) {
      toast.error(error.message);
      qc.invalidateQueries({ queryKey: ["incog_profiles"] });
    } else {
      toast.success(nextState ? "Profile set to Active" : "Profile set to Inactive");
    }
  }

  async function updatePriority(p: Profile, priority: ProfilePriority) {
    const previousPriority = p.profile_priority;
    qc.setQueryData(["incog_profiles"], (old: Profile[] | undefined) => {
      if (!old) return old;
      return old.map((profile) =>
        profile.id === p.id ? { ...profile, profile_priority: priority } : profile,
      );
    });

    const { error } = await supabase
      .from("incogniton_profiles")
      .update({ profile_priority: priority })
      .eq("id", p.id);
    if (error) {
      qc.setQueryData(["incog_profiles"], (old: Profile[] | undefined) => {
        if (!old) return old;
        return old.map((profile) =>
          profile.id === p.id ? { ...profile, profile_priority: previousPriority } : profile,
        );
      });
      toast.error(error.message);
      return;
    }

    toast.success(
      priority === "first"
        ? "Moved to 1st Priority"
        : priority === "second"
          ? "Moved to 2nd Priority"
          : "Removed from priority lists",
    );
  }

  function dateKey(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatAddedDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="space-y-4">
      {/* How launch works — info banner */}
      <div className="text-[12px] bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
        <div>
          <span className="font-medium">How launching works:</span> Click{" "}
          <strong>Add Profile</strong> below to save your Incogniton profile ID and name. Then hit{" "}
          <strong>Launch</strong> — it sends the open command directly to Incogniton on your PC.
          Make sure Incogniton is running. Not sure of your profile ID?{" "}
          <button className="underline text-primary" onClick={() => setHowToOpen(true)}>
            See how to find it.
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {profileView !== "performance" && profileView !== "groups" && (
          <>
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search profile name or ID…"
                className="h-9 pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="added-date-filter" className="text-[12px] text-muted-foreground">
                Added
              </Label>
              <Input
                id="added-date-filter"
                type="date"
                value={addedDateFilter}
                onChange={(event) => setAddedDateFilter(event.target.value)}
                className="h-9 w-[150px]"
              />
              {addedDateFilter && (
                <Button variant="ghost" size="sm" onClick={() => setAddedDateFilter("")}>
                  Clear
                </Button>
              )}
            </div>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {profileView !== "performance" && selectedProfiles.length > 0 && (
            <Button variant="outline" onClick={removeSelected} className="text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete {selectedProfiles.length}
            </Button>
          )}
          <Button variant="outline" onClick={handleDownloadBridge} disabled={downloadingBridge}>
            {downloadingBridge ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5" />
            )}{" "}
            Bridge
          </Button>
          <Button
            variant="outline"
            onClick={handleDownloadExtension}
            disabled={downloadingExtension}
          >
            {downloadingExtension ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5" />
            )}{" "}
            Extension
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-3.5 w-3.5 mr-1.5" /> Import
          </Button>
          {auth.primaryRole === "admin" && (
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export
            </Button>
          )}
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Profile
          </Button>
        </div>
      </div>

      <Tabs value={profileView} onValueChange={(value) => setProfileView(value as ProfileView)}>
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto p-1.5 sm:w-auto">
          <TabsTrigger value="all" className="gap-2">
            All Profiles
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
              {profileCounts.all}
            </span>
          </TabsTrigger>
          <TabsTrigger value="first" className="gap-2">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
            1st Priority
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-700 dark:text-amber-300">
              {profileCounts.first}
            </span>
          </TabsTrigger>
          <TabsTrigger value="second" className="gap-2">
            <Star className="h-3.5 w-3.5 text-slate-500" />
            2nd Priority
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
              {profileCounts.second}
            </span>
          </TabsTrigger>
          <TabsTrigger value="other" className="gap-2">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            Other Accounts
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
              {profileCounts.other}
            </span>
          </TabsTrigger>
          <TabsTrigger value="launched_today" className="gap-2">
            <CalendarCheck className="h-3.5 w-3.5 text-success" />
            Launched Today
            <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] tabular-nums text-success">
              {profileCounts.launchedToday}
            </span>
          </TabsTrigger>
          <TabsTrigger value="groups" className="gap-2">
            <Layers className="h-3.5 w-3.5 text-primary" />
            Groups
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] tabular-nums text-primary">
              {groups.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-primary" />
            Profile Performance
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {profileView === "performance" ? (
        <ProfilePerformance todayKey={todayKey} />
      ) : profileView === "groups" ? (
        <GroupsManager
          profiles={profiles.data ?? []}
          dbGroups={groups}
          onChanged={() => qc.invalidateQueries({ queryKey: ["incog_profiles"] })}
        />
      ) : (
        <div className="bg-card border rounded-lg overflow-x-auto">
          <table className="crm-table min-w-[1220px]">
            <thead>
              <tr>
                <th className="w-10">
                  <Checkbox
                    checked={allFilteredSelected}
                    disabled={filtered.length === 0}
                    aria-label="Select all visible profiles"
                    onCheckedChange={(checked) => toggleAllFiltered(checked === true)}
                  />
                </th>
                <th>
                  <SortHeader
                    label="Profile Name"
                    active={profileSort.key === "profile_name"}
                    direction={profileSort.direction}
                    onClick={() => toggleProfileSort("profile_name")}
                  />
                </th>
                <th>
                  <SortHeader
                    label="Profile ID"
                    active={profileSort.key === "profile_id"}
                    direction={profileSort.direction}
                    onClick={() => toggleProfileSort("profile_id")}
                  />
                </th>
                <th>
                  <SortHeader
                    label="Group"
                    active={profileSort.key === "group"}
                    direction={profileSort.direction}
                    onClick={() => toggleProfileSort("group")}
                  />
                </th>
                <th>
                  <SortHeader
                    label="Account Area"
                    active={profileSort.key === "account_area"}
                    direction={profileSort.direction}
                    onClick={() => toggleProfileSort("account_area")}
                  />
                </th>
                <th>
                  <SortHeader
                    label="Geo"
                    active={profileSort.key === "geo"}
                    direction={profileSort.direction}
                    onClick={() => toggleProfileSort("geo")}
                  />
                </th>
                <th>
                  <SortHeader
                    label="Added Date"
                    active={profileSort.key === "added_date"}
                    direction={profileSort.direction}
                    onClick={() => toggleProfileSort("added_date")}
                  />
                </th>
                <th>
                  <SortHeader
                    label="Last Launched"
                    active={profileSort.key === "last_launched"}
                    direction={profileSort.direction}
                    onClick={() => toggleProfileSort("last_launched")}
                  />
                </th>
                <th>Priority</th>
                <th>Status</th>
                <th>Notes</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.isLoading && !profiles.data && (
                <tr>
                  <td colSpan={12} className="text-center py-6 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!profiles.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={12} className="text-center py-10 text-muted-foreground">
                    <Globe className="h-5 w-5 inline mr-2 opacity-50" />
                    {profileView === "all"
                      ? "No browser profiles found."
                      : profileView === "launched_today"
                        ? "No profiles launched today."
                        : profileView === "other"
                          ? "No accounts without a priority."
                          : `No ${profileView === "first" ? "1st" : "2nd"} Priority profiles.`}
                  </td>
                </tr>
              )}
              {filtered.map((p) => {
                const status = statusOf(p);
                return (
                  <tr key={p.id} className="crm-data-row">
                    <td>
                      <Checkbox
                        checked={selectedProfileIds.has(p.id)}
                        aria-label={`Select ${p.profile_name}`}
                        onCheckedChange={(checked) =>
                          toggleProfileSelection(p.id, checked === true)
                        }
                      />
                    </td>
                    <td className="font-medium">{p.profile_name}</td>
                    <td className="font-mono text-[11px] text-muted-foreground">
                      {p.incogniton_profile_id}
                    </td>
                    <td className="text-[12.5px]">{p.group_name ?? "—"}</td>
                    <td className="text-[12.5px]">{p.account_area ?? "—"}</td>
                    <td className="text-[11.5px] font-mono text-muted-foreground">
                      {p.latitude != null && p.longitude != null
                        ? `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`
                        : "—"}
                    </td>
                    <td className="text-[12px] whitespace-nowrap">
                      <div className="font-medium">{formatAddedDate(p.created_at)}</div>
                      <div className="text-[10.5px] text-muted-foreground">
                        {new Date(p.created_at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </td>
                    <td>
                      {p.last_launched_at ? (
                        <button
                          type="button"
                          onClick={() => setHistoryFor(p)}
                          className="flex flex-col gap-0.5 text-left hover:opacity-80"
                          title="View last 5 launches"
                        >
                          <span
                            className={cn(
                              "text-[10.5px] px-2 py-0.5 rounded-full border w-fit",
                              status === "Launched recently"
                                ? "bg-success/10 text-success border-success/30"
                                : "bg-muted text-muted-foreground border-border",
                            )}
                          >
                            {status}
                          </span>
                          <span className="text-[11px] font-medium text-foreground pl-0.5">
                            {p.launched_by_name ?? p.launched_by_email ?? "Unknown"}
                          </span>
                          <span className="text-[10px] text-muted-foreground pl-0.5">
                            {new Date(p.last_launched_at).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/50 italic">
                          Never launched
                        </span>
                      )}
                    </td>
                    <td className="min-w-[145px]">
                      <Select
                        value={p.profile_priority}
                        onValueChange={(value) => updatePriority(p, value as ProfilePriority)}
                      >
                        <SelectTrigger
                          className={cn(
                            "h-8 text-[11px]",
                            p.profile_priority === "first" &&
                              "border-amber-400/60 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                            p.profile_priority === "second" && "bg-muted/70",
                          )}
                          aria-label={`Change priority for ${p.profile_name}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No priority</SelectItem>
                          <SelectItem value="first">1st Priority</SelectItem>
                          <SelectItem value="second">2nd Priority</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleActive(p)}
                        className={cn(
                          "text-[11px] h-7 px-2",
                          p.is_active
                            ? "text-success border-success/30"
                            : "text-muted-foreground border-border",
                        )}
                      >
                        {p.is_active ? "Active" : "Inactive"}
                      </Button>
                    </td>
                    <td className="max-w-[120px]">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setNoteFor(p)}
                        className="h-7 px-2 text-[11px]"
                      >
                        {p.notes ? "Edit Note" : "Add Note"}
                      </Button>
                      {p.notes && (
                        <div
                          className="text-[10px] text-muted-foreground truncate mt-0.5"
                          title={p.notes}
                        >
                          {p.notes}
                        </div>
                      )}
                    </td>
                    <td className="text-right space-x-1.5 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => launch(p)}
                        title="Launch in Incogniton"
                      >
                        <Rocket className="h-3.5 w-3.5 mr-1" /> Launch
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingFor(p)}
                        title="Edit profile"
                        aria-label={`Edit ${p.profile_name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => remove(p)} title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {addOpen && (
        <ProfileDialog
          userId={auth.user?.id ?? null}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            qc.invalidateQueries({ queryKey: ["incog_profiles"] });
          }}
        />
      )}
      {editingFor && (
        <ProfileDialog
          userId={auth.user?.id ?? null}
          profile={editingFor}
          onClose={() => setEditingFor(null)}
          onSaved={() => {
            setEditingFor(null);
            qc.invalidateQueries({ queryKey: ["incog_profiles"] });
          }}
        />
      )}
      <ImportDialog
        open={importOpen}
        userId={auth.user?.id ?? null}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          qc.invalidateQueries({ queryKey: ["incog_profiles"] });
        }}
      />
      <ExportDialog
        open={exportOpen}
        profiles={profiles.data ?? []}
        groups={groups}
        onClose={() => setExportOpen(false)}
      />
      {noteFor && (
        <Dialog open onOpenChange={(o) => !o && setNoteFor(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Note · {noteFor.profile_name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <textarea
                className="w-full min-h-[100px] text-sm p-3 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                defaultValue={noteFor.notes || ""}
                id="note-input"
                placeholder="Type your note here..."
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setNoteFor(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    const val = (
                      document.getElementById("note-input") as HTMLTextAreaElement
                    ).value.trim();
                    qc.setQueryData(["incog_profiles"], (old: Profile[] | undefined) => {
                      if (!old) return old;
                      return old.map((profile) =>
                        profile.id === noteFor.id ? { ...profile, notes: val } : profile,
                      );
                    });
                    setNoteFor(null);
                    const { error } = await supabase
                      .from("incogniton_profiles")
                      .update({ notes: val })
                      .eq("id", noteFor.id);
                    if (error) {
                      toast.error(error.message);
                      qc.invalidateQueries({ queryKey: ["incog_profiles"] });
                    } else {
                      toast.success("Note saved");
                    }
                  }}
                >
                  Save Note
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {historyFor && (
        <Dialog open onOpenChange={(o) => !o && setHistoryFor(null)}>
          <DialogContent className="max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Last 5 launches · {historyFor.profile_name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              {(historyFor.launch_history ?? []).length === 0 ? (
                <div className="text-[12.5px] text-muted-foreground">No history yet.</div>
              ) : (
                (historyFor.launch_history ?? []).slice(0, 5).map((h, i) => (
                  <div
                    key={i}
                    className="flex justify-between text-[12.5px] bg-muted/30 rounded px-3 py-2"
                  >
                    <span className="font-medium">{h.by ?? "Unknown"}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {new Date(h.at).toLocaleString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* How to find profile ID */}
      <Dialog open={howToOpen} onOpenChange={setHowToOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>How to find your Incogniton Profile ID</DialogTitle>
            <DialogDescription>
              The Profile ID is the unique identifier Incogniton uses to open a profile.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-[13px]">
            <div className="space-y-2">
              <div className="font-medium">Method 1 — From the Incogniton app (easiest)</div>
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                <li>Open the Incogniton desktop app.</li>
                <li>
                  Right-click any profile → <strong>Profile Info</strong> or <strong>Edit</strong>.
                </li>
                <li>Copy the ID shown at the top (looks like a long number or UUID).</li>
              </ol>
            </div>
            <div className="space-y-2">
              <div className="font-medium">Method 2 — From the local API</div>
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                <li>Make sure Incogniton is running.</li>
                <li>
                  Open this URL in your browser tab:{" "}
                  <code className="font-mono text-[11px] bg-muted px-1 py-0.5 rounded">
                    http://localhost:35000/profile/all
                  </code>
                </li>
                <li>
                  You'll see a JSON list. Find your profile and copy the{" "}
                  <code className="font-mono text-[11px]">profile_browser_id</code> field.
                </li>
              </ol>
            </div>
            <div className="bg-muted/40 rounded p-3 text-[12px] text-muted-foreground">
              <strong>Tip:</strong> The profile name is just a label for your CRM — it doesn't need
              to match the name in Incogniton exactly, but keeping them the same avoids confusion.
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function profilePerformanceRange(
  preset: PerformancePreset,
  customFrom: string,
  customTo: string,
  today: string,
) {
  const todayStart = new Date(`${today}T00:00:00+05:00`);
  const dayMs = 24 * 60 * 60 * 1000;

  if (preset === "custom") {
    if (!customFrom || !customTo) return null;
    const from = new Date(`${customFrom}T00:00:00+05:00`);
    const to = new Date(new Date(`${customTo}T00:00:00+05:00`).getTime() + dayMs);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return null;
    return { from: from.toISOString(), to: to.toISOString() };
  }

  const days = preset === "today" ? 1 : preset === "week" ? 7 : 30;
  return {
    from: new Date(todayStart.getTime() - (days - 1) * dayMs).toISOString(),
    to: new Date(todayStart.getTime() + dayMs).toISOString(),
  };
}

function ProfilePerformance({ todayKey: today }: { todayKey: string }) {
  const [preset, setPreset] = useState<PerformancePreset>("today");
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const range = useMemo(
    () => profilePerformanceRange(preset, customFrom, customTo, today),
    [customFrom, customTo, preset, today],
  );

  const report = useQuery({
    queryKey: ["browser-profile-performance", range?.from, range?.to],
    enabled: !!range,
    queryFn: async () => {
      if (!range) return [];
      const { data, error } = await supabase.rpc("browser_profile_performance", {
        _from: range.from,
        _to: range.to,
      });
      if (error) throw error;
      return (data ?? []) as ProfilePerformanceRow[];
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => report.data ?? [], [report.data]);
  const totals = useMemo(
    () =>
      rows.reduce(
        (sum, row) => ({
          scraped: sum.scraped + Number(row.scraped_posts),
          forwarded: sum.forwarded + Number(row.forwarded),
          delivered: sum.delivered + Number(row.delivered),
          interested: sum.interested + Number(row.cx_interested),
        }),
        { scraped: 0, forwarded: 0, delivered: 0, interested: 0 },
      ),
    [rows],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-sm font-semibold">Profile performance</h3>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Profiles launched in the selected PKT date range and the posts they scraped during
              that same range.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            {(
              [
                ["today", "Today"],
                ["week", "7 days"],
                ["month", "30 days"],
                ["custom", "Custom"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={preset === value ? "default" : "outline"}
                onClick={() => setPreset(value)}
              >
                {label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!range || report.isFetching}
              onClick={() => report.refetch()}
            >
              <RefreshCw
                className={cn("mr-1.5 h-3.5 w-3.5", report.isFetching && "animate-spin")}
              />
              Refresh
            </Button>
          </div>
        </div>
        {preset === "custom" && (
          <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg bg-muted/30 p-3">
            <Field label="From">
              <Input
                type="date"
                value={customFrom}
                max={customTo || today}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="w-[160px]"
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={customTo}
                min={customFrom}
                max={today}
                onChange={(event) => setCustomTo(event.target.value)}
                className="w-[160px]"
              />
            </Field>
            {!range && (
              <p className="pb-2 text-xs text-destructive">Choose a valid start and end date.</p>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <PerformanceStat label="Profiles launched" value={rows.length} />
        <PerformanceStat label="Posts scraped" value={totals.scraped} />
        <PerformanceStat label="Forwarded" value={totals.forwarded} />
        <PerformanceStat label="Delivered" value={totals.delivered} />
        <PerformanceStat label="CX interested" value={totals.interested} />
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="crm-table min-w-[1020px]">
          <thead>
            <tr>
              <th>Profile</th>
              <th>City / State</th>
              <th>Priority</th>
              <th className="text-right">Launches</th>
              <th className="text-right">Scraped</th>
              <th className="text-right">Forwarded</th>
              <th className="text-right">Delivered</th>
              <th className="text-right">CX Interested</th>
              <th>Top Service</th>
            </tr>
          </thead>
          <tbody>
            {report.isLoading && !report.data && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading performance…
                </td>
              </tr>
            )}
            {report.isError && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-destructive">
                  Could not load profile performance. {String(report.error.message)}
                </td>
              </tr>
            )}
            {!report.isLoading && !report.isError && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-muted-foreground">
                  No profiles were launched in this date range.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.profile_id} className="crm-data-row">
                <td>
                  <div className="font-medium">{row.profile_name}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {row.incogniton_profile_id}
                  </div>
                </td>
                <td>{row.account_area || "—"}</td>
                <td>
                  <PriorityBadge priority={row.profile_priority} />
                </td>
                <MetricCell value={row.launch_count} />
                <MetricCell value={row.scraped_posts} />
                <MetricCell value={row.forwarded} />
                <MetricCell value={row.delivered} />
                <MetricCell value={row.cx_interested} />
                <td className="font-medium">{row.top_service || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PerformanceStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

function MetricCell({ value }: { value: number }) {
  return (
    <td className="text-right font-semibold tabular-nums">{Number(value).toLocaleString()}</td>
  );
}

function PriorityBadge({ priority }: { priority: ProfilePriority }) {
  if (priority === "first") {
    return (
      <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
        1st Priority
      </span>
    );
  }
  if (priority === "second") {
    return <span className="rounded-full bg-muted px-2 py-1 text-[11px]">2nd Priority</span>;
  }
  return <span className="text-[11px] text-muted-foreground">No priority</span>;
}

const PROFILE_SHEET_HEADERS = [
  "account name",
  "profile id",
  "account area",
  "latitude",
  "longitude",
] as const;

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function toSheetRow(profile: Profile): ProfileSheetRow {
  return {
    "account name": profile.profile_name,
    "profile id": profile.incogniton_profile_id,
    "account area": profile.account_area ?? "",
    latitude: profile.latitude ?? "",
    longitude: profile.longitude ?? "",
  };
}

function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      field = "";
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  if (rows.length === 0) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows
    .slice(1)
    .map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
    );
}

function normalizeSheetRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value])),
  );
}

function validateSheetRows(rawRows: Record<string, unknown>[]) {
  if (rawRows.length === 0) throw new Error("The selected file has no profile rows.");
  const missingHeaders = PROFILE_SHEET_HEADERS.filter((header) => !(header in rawRows[0]));
  if (missingHeaders.length > 0) {
    throw new Error(`Missing required column header: ${missingHeaders.join(", ")}`);
  }

  return rawRows.map((row, index) => {
    const rowNumber = index + 2;
    const accountName = String(row["account name"] ?? "").trim();
    const profileId = String(row["profile id"] ?? "").trim();
    const accountArea = String(row["account area"] ?? "").trim();
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);

    if (!accountName) throw new Error(`Row ${rowNumber}: account name is required.`);
    if (!profileId) throw new Error(`Row ${rowNumber}: profile id is required.`);
    if (!accountArea) throw new Error(`Row ${rowNumber}: account area is required.`);
    if (!Number.isFinite(latitude)) throw new Error(`Row ${rowNumber}: latitude must be a number.`);
    if (!Number.isFinite(longitude))
      throw new Error(`Row ${rowNumber}: longitude must be a number.`);
    if (latitude < -90 || latitude > 90) {
      throw new Error(`Row ${rowNumber}: latitude must be between -90 and 90.`);
    }
    if (longitude < -180 || longitude > 180) {
      throw new Error(`Row ${rowNumber}: longitude must be between -180 and 180.`);
    }

    return {
      profile_name: accountName,
      incogniton_profile_id: profileId,
      account_area: accountArea,
      latitude,
      longitude,
    };
  });
}

async function downloadProfiles(filenameBase: string, format: FileFormat, rows: ProfileSheetRow[]) {
  if (format === "csv") {
    const headers = [...PROFILE_SHEET_HEADERS];
    const dataRows = rows.map((row) => headers.map((h) => row[h] ?? ""));
    downloadCsv(`${filenameBase}.csv`, headers, dataRows);
    return;
  }

  // Export xlsx
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Browser Profiles");
  worksheet.columns = PROFILE_SHEET_HEADERS.map((h) => ({ header: h, key: h }));
  rows.forEach((row) => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Add / edit profile dialog ────────────────────────────────────────────────

function ProfileDialog({
  userId,
  profile,
  onClose,
  onSaved,
}: {
  userId: string | null;
  profile?: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [profileId, setProfileId] = useState(profile?.incogniton_profile_id ?? "");
  const [profileName, setProfileName] = useState(profile?.profile_name ?? "");
  const [groupName, setGroupName] = useState(profile?.group_name ?? "");
  const [accountArea, setAccountArea] = useState(profile?.account_area ?? "");
  const [latitude, setLatitude] = useState(profile?.latitude?.toString() ?? "");
  const [longitude, setLongitude] = useState(profile?.longitude?.toString() ?? "");
  const [priority, setPriority] = useState<ProfilePriority>(profile?.profile_priority ?? "none");
  const [saving, setSaving] = useState(false);

  async function save() {
    const id = profileId.trim();
    const name = profileName.trim();
    const area = accountArea.trim();
    const latStr = latitude.trim();
    const lngStr = longitude.trim();
    if (!id) {
      toast.error("Profile ID is required");
      return;
    }
    if (!name) {
      toast.error("Profile name is required");
      return;
    }
    if (!area) {
      toast.error("Account Area is required");
      return;
    }
    if (!latStr || !lngStr) {
      toast.error("Latitude and longitude are required");
      return;
    }
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      toast.error("Latitude and longitude must be valid numbers");
      return;
    }
    setSaving(true);
    const values = {
      incogniton_profile_id: id,
      profile_name: name,
      group_name: groupName.trim() || null,
      account_area: area,
      latitude: lat,
      longitude: lng,
      profile_priority: priority,
    } satisfies IncognitonProfileUpdate;
    const { error } = profile
      ? await supabase.from("incogniton_profiles").update(values).eq("id", profile.id)
      : await supabase.from("incogniton_profiles").insert({
          ...values,
          created_by: userId,
        } satisfies IncognitonProfileInsert);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(profile ? "Profile updated ✓" : "Profile saved ✓");
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-card w-full max-w-md rounded-lg border p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold">
            {profile ? "Edit Incogniton Profile" : "Add Incogniton Profile"}
          </h2>
          <p className="text-[12px] text-muted-foreground mt-1">
            Only Group is optional. Geo coordinates will plot the profile on the map with a 50-mile
            radius.
          </p>
        </div>

        <div className="space-y-3">
          <Field label="Profile ID *">
            <Input
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              placeholder="e.g. 1234567890 or abc-def-123"
              autoFocus
            />
          </Field>
          <Field label="Profile Name *">
            <Input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="e.g. Account A – Facebook"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Group (optional)">
              <Input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. testing"
              />
            </Field>
            <Field label="Account Area *">
              <Input
                value={accountArea}
                onChange={(e) => setAccountArea(e.target.value)}
                placeholder="e.g. CA · Fountain Valley"
              />
            </Field>
          </div>
          <Field label="Priority">
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value as ProfilePriority)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No priority</SelectItem>
                <SelectItem value="first">1st Priority</SelectItem>
                <SelectItem value="second">2nd Priority</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude *">
              <Input
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="e.g. 33.7092"
                inputMode="decimal"
              />
            </Field>
            <Field label="Longitude *">
              <Input
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="e.g. -117.9536"
                inputMode="decimal"
              />
            </Field>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {profile ? "Save Changes" : "Save Profile"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Export Dialog ─────────────────────────────────────────────────────────────

function ImportDialog({
  open,
  userId,
  onClose,
  onImported,
}: {
  open: boolean;
  userId: string | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const [format, setFormat] = useState<FileFormat>("xlsx");
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const safeClose = () => {
    if (!importing) onClose();
  };

  async function readRows() {
    if (!file) throw new Error("Choose a file to import.");
    if (format === "csv") return parseCsv(await file.text());

    const buffer = await file.arrayBuffer();
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("The workbook does not contain any sheets.");
    const rows: Record<string, unknown>[] = [];
    const headers: string[] = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        const values = row.values as unknown[];
        for (let i = 1; i < values.length; i++) {
          headers.push(String(values[i] ?? "").trim());
        }
      } else {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < headers.length; i++) {
          const cellValue = row.getCell(i + 1).value;
          let val = cellValue;
          if (cellValue && typeof cellValue === "object") {
            if ("result" in cellValue) {
              val = cellValue.result;
            } else if ("text" in cellValue) {
              val = cellValue.text;
            }
          }
          obj[headers[i]] = val ?? "";
        }
        rows.push(obj);
      }
    });
    return normalizeSheetRows(rows);
  }

  async function importProfiles() {
    setImporting(true);
    try {
      if (!userId) throw new Error("You must be signed in to import profiles.");
      const allRows = validateSheetRows(await readRows()).map(
        (row) =>
          ({
            ...row,
            created_by: userId,
          }) satisfies IncognitonProfileInsert,
      );
      // Dedupe by incogniton_profile_id (FIRST occurrence wins) — Postgres ON CONFLICT
      // rejects batches that hit the same conflict target twice.
      const dedup = new Map<string, IncognitonProfileInsert>();
      const skippedRows: { profile_name: string; incogniton_profile_id: string }[] = [];
      for (const row of allRows) {
        if (dedup.has(row.incogniton_profile_id)) {
          skippedRows.push({
            profile_name: row.profile_name,
            incogniton_profile_id: row.incogniton_profile_id,
          });
        } else {
          dedup.set(row.incogniton_profile_id, row);
        }
      }
      const rows = Array.from(dedup.values());
      const BATCH_SIZE = 50;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { error } = await withTimeout(
          supabase.from("incogniton_profiles").upsert(batch, {
            onConflict: "incogniton_profile_id",
            ignoreDuplicates: false,
          }),
          20000,
          "Import timed out. Please try a smaller file or check your connection.",
        );
        if (error) {
          console.error("[Import profiles] Supabase error:", error);
          throw new Error(
            error.message ||
              error.hint ||
              error.details ||
              "Database rejected the import (check your role / RLS).",
          );
        }
      }

      if (skippedRows.length > 0) {
        const preview = skippedRows
          .slice(0, 8)
          .map((r) => `• ${r.profile_name}`)
          .join("\n");
        const extra = skippedRows.length > 8 ? `\n…and ${skippedRows.length - 8} more` : "";
        toast.warning(
          `Imported ${rows.length} • Skipped ${skippedRows.length} duplicate profile id${skippedRows.length === 1 ? "" : "s"}`,
          { description: preview + extra, duration: 12000 },
        );
        console.warn("[Import profiles] Skipped duplicates:", skippedRows);
      } else {
        toast.success(`Imported ${rows.length} profile${rows.length === 1 ? "" : "s"}`);
      }
      onImported();
    } catch (error) {
      console.error("[Import profiles] Failed:", error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : "Could not import profiles";
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && safeClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import Profiles</DialogTitle>
          <DialogDescription>
            Bulk-add Incogniton profiles from an XLSX or CSV file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="block mb-1.5">Format</Label>
            <Select value={format} onValueChange={(value) => setFormat(value as FileFormat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="xlsx">XLSX</SelectItem>
                <SelectItem value="csv">CSV</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="block mb-1.5">File</Label>
            <Input
              type="file"
              accept={format === "xlsx" ? ".xlsx" : ".csv,text/csv"}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="bg-muted/40 rounded p-3 text-[12px] text-muted-foreground">
            Required headers: account name, profile id, account area, latitude, longitude.
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={safeClose} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={importProfiles} disabled={importing || !file}>
            {importing && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Import
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Groups: create, assign, rename, and launch a whole group at once ─────────
const GROUP_LAUNCH_ATTEMPTS = 3; // first try + 2 retries per profile
const DRAFT_GROUPS_KEY = "incog_draft_groups";
const UNGROUP_VALUE = "__ungroup__";

/** Small priority marker reused in group rows and the assign list. */
function PriorityStar({ priority }: { priority: ProfilePriority }) {
  if (priority === "first")
    return <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" aria-hidden />;
  if (priority === "second")
    return <Star className="h-3 w-3 shrink-0 text-slate-500" aria-hidden />;
  return null;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readDraftGroups(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_GROUPS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeDraftGroups(names: string[]) {
  try {
    localStorage.setItem(DRAFT_GROUPS_KEY, JSON.stringify([...new Set(names)]));
  } catch {
    /* localStorage unavailable — empty groups just won't persist across reloads */
  }
}

/** Records a successful launch (last_launched + history), same as the single
 * Launch button, so group and per-profile launches stay consistent. */
async function recordProfileLaunch(p: Profile, who: string, email: string | null) {
  const nowIso = new Date().toISOString();
  const prevHistory = Array.isArray(p.launch_history) ? p.launch_history : [];
  const nextHistory = [{ at: nowIso, by: who }, ...prevHistory].slice(0, 100);
  await supabase
    .from("incogniton_profiles")
    .update({
      last_launched_at: nowIso,
      launched_by_name: who,
      launched_by_email: email,
      launch_history: nextHistory as Json,
    })
    .eq("id", p.id);
}

/** Launches one profile, retrying up to GROUP_LAUNCH_ATTEMPTS times on error.
 * Returns true if it eventually succeeded. */
async function launchWithRetry(p: Profile): Promise<boolean> {
  for (let attempt = 1; attempt <= GROUP_LAUNCH_ATTEMPTS; attempt++) {
    try {
      await launchIncognitonProfile(p.incogniton_profile_id);
      return true;
    } catch {
      if (attempt < GROUP_LAUNCH_ATTEMPTS) await sleep(1500);
    }
  }
  return false;
}

function GroupsManager({
  profiles,
  dbGroups,
  onChanged,
}: {
  profiles: Profile[];
  dbGroups: string[];
  onChanged: () => void;
}) {
  const auth = useAuth();
  // Empty groups have nowhere to live in the schema (group is a column on the
  // profile), so a freshly created group with no profiles yet is remembered in
  // localStorage until something is assigned to it.
  const [draftGroups, setDraftGroups] = useState<string[]>(() => readDraftGroups());
  const [newGroup, setNewGroup] = useState("");
  const [launchingGroup, setLaunchingGroup] = useState<string | null>(null);
  const [launchingProfileId, setLaunchingProfileId] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const launchBusy = launchingGroup !== null || launchingProfileId !== null;

  const groupNames = useMemo(
    () => Array.from(new Set([...dbGroups, ...draftGroups])).sort((a, b) => a.localeCompare(b)),
    [dbGroups, draftGroups],
  );
  const profilesByGroup = useMemo(() => {
    const map = new Map<string, Profile[]>();
    for (const name of groupNames) map.set(name, []);
    for (const p of profiles)
      if (p.group_name) {
        if (!map.has(p.group_name)) map.set(p.group_name, []);
        map.get(p.group_name)!.push(p);
      }
    return map;
  }, [profiles, groupNames]);
  const ungroupedCount = useMemo(() => profiles.filter((p) => !p.group_name).length, [profiles]);

  function persistDrafts(next: string[]) {
    setDraftGroups(next);
    writeDraftGroups(next);
  }

  function createGroup() {
    const name = newGroup.trim();
    if (!name) return;
    if (groupNames.some((g) => g.toLowerCase() === name.toLowerCase())) {
      toast.error("A group with that name already exists");
      return;
    }
    persistDrafts([...draftGroups, name]);
    setNewGroup("");
    toast.success(`Group "${name}" created — now assign profiles to it below.`);
  }

  async function assignProfiles(groupName: string, ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    const { error } = await supabase
      .from("incogniton_profiles")
      .update({ group_name: groupName })
      .in("id", ids);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(`Added ${ids.length} profile${ids.length === 1 ? "" : "s"} to "${groupName}"`);
    onChanged();
  }

  async function removeProfile(id: string) {
    setBusy(true);
    const { error } = await supabase
      .from("incogniton_profiles")
      .update({ group_name: null })
      .eq("id", id);
    setBusy(false);
    if (error) return toast.error(error.message);
    onChanged();
  }

  // Move a profile to another group (or ungroup) straight from the group card.
  async function moveProfile(id: string, target: string) {
    const groupName = target === UNGROUP_VALUE ? null : target;
    setBusy(true);
    const { error } = await supabase
      .from("incogniton_profiles")
      .update({ group_name: groupName })
      .eq("id", id);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(groupName ? `Moved to "${groupName}"` : "Removed from group");
    onChanged();
  }

  // Launch a single profile from the group card, with the same 3-try retry.
  async function launchOne(p: Profile) {
    if (launchBusy) return;
    setLaunchingProfileId(p.id);
    const user = auth.user;
    const who = user?.user_metadata?.full_name ?? user?.email?.split("@")[0] ?? "Unknown";
    toast.loading(`Launching ${p.profile_name}…`, { id: "one-launch" });
    const ok = await launchWithRetry(p);
    if (ok) {
      await recordProfileLaunch(p, who, user?.email ?? null);
      toast.success(`Launched ${p.profile_name} ✓`, { id: "one-launch" });
    } else {
      toast.error(
        `Could not launch ${p.profile_name} after 3 tries. Is Incogniton/the Bridge up?`,
        {
          id: "one-launch",
          duration: 7000,
        },
      );
    }
    onChanged();
    setLaunchingProfileId(null);
  }

  async function renameGroup(oldName: string) {
    const name = renameValue.trim();
    setRenamingGroup(null);
    if (!name || name === oldName) return;
    if (groupNames.some((g) => g.toLowerCase() === name.toLowerCase() && g !== oldName)) {
      toast.error("A group with that name already exists");
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("incogniton_profiles")
      .update({ group_name: name })
      .eq("group_name", oldName);
    setBusy(false);
    if (error) return toast.error(error.message);
    persistDrafts([...draftGroups.filter((g) => g !== oldName), name]);
    toast.success(`Renamed "${oldName}" → "${name}"`);
    onChanged();
  }

  async function deleteGroup(groupName: string, members: Profile[]) {
    if (
      !confirm(
        `Delete group "${groupName}"? Its ${members.length} profile${
          members.length === 1 ? "" : "s"
        } will be unassigned. The profiles themselves are not deleted.`,
      )
    )
      return;
    if (members.length) {
      setBusy(true);
      const { error } = await supabase
        .from("incogniton_profiles")
        .update({ group_name: null })
        .eq("group_name", groupName);
      setBusy(false);
      if (error) return toast.error(error.message);
    }
    persistDrafts(draftGroups.filter((g) => g !== groupName));
    toast.success(`Group "${groupName}" deleted`);
    onChanged();
  }

  async function launchGroup(groupName: string, members: Profile[]) {
    const launchable = members.filter((p) => p.is_active !== false);
    if (launchable.length === 0) {
      toast.error("No active profiles in this group to launch.");
      return;
    }
    setLaunchingGroup(groupName);
    const user = auth.user;
    const who = user?.user_metadata?.full_name ?? user?.email?.split("@")[0] ?? "Unknown";
    let success = 0;
    const failed: string[] = [];
    for (let i = 0; i < launchable.length; i++) {
      const p = launchable[i];
      toast.loading(
        `Launching "${groupName}" — ${p.profile_name} (${i + 1}/${launchable.length})…`,
        { id: "group-launch" },
      );
      // First attempt plus two retries, so a flaky profile gets three tries.
      const ok = await launchWithRetry(p);
      if (ok) {
        success++;
        await recordProfileLaunch(p, who, user?.email ?? null);
      } else {
        failed.push(p.profile_name);
      }
      // A small gap so the bridge/Incogniton isn't hammered all at once.
      await sleep(700);
    }
    onChanged();
    setLaunchingGroup(null);
    if (failed.length === 0)
      toast.success(
        `Launched all ${success} profile${success === 1 ? "" : "s"} in "${groupName}" ✓`,
        {
          id: "group-launch",
        },
      );
    else
      toast.error(
        `"${groupName}": launched ${success}/${launchable.length}. Failed after 3 tries: ${failed.join(
          ", ",
        )}`,
        { id: "group-launch", duration: 9000 },
      );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <FolderPlus className="h-4 w-4 text-primary shrink-0" />
        <Input
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createGroup()}
          placeholder="New group name…"
          className="h-9 flex-1 min-w-[200px] max-w-sm"
        />
        <Button onClick={createGroup} disabled={!newGroup.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Create group
        </Button>
        <span className="ml-auto text-[12px] text-muted-foreground">
          {groupNames.length} group{groupNames.length === 1 ? "" : "s"} · {ungroupedCount} ungrouped
          profile{ungroupedCount === 1 ? "" : "s"}
        </span>
      </div>

      {groupNames.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-[13px] text-muted-foreground">
          <Layers className="mx-auto mb-2 h-6 w-6 opacity-50" />
          No groups yet. Create one above, then assign profiles and launch them all with one click.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groupNames.map((name) => {
            const members = profilesByGroup.get(name) ?? [];
            const activeCount = members.filter((p) => p.is_active !== false).length;
            const isRenaming = renamingGroup === name;
            return (
              <div key={name} className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-center gap-2">
                  {isRenaming ? (
                    <>
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameGroup(name);
                          if (e.key === "Escape") setRenamingGroup(null);
                        }}
                        className="h-8 flex-1"
                      />
                      <Button size="sm" variant="ghost" onClick={() => renameGroup(name)}>
                        <Check className="h-4 w-4 text-success" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenamingGroup(null)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Layers className="h-4 w-4 text-primary shrink-0" />
                      <h3 className="font-semibold truncate flex-1">{name}</h3>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                        {members.length} profile{members.length === 1 ? "" : "s"}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Rename group"
                        onClick={() => {
                          setRenamingGroup(name);
                          setRenameValue(name);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Delete group"
                        className="text-destructive"
                        onClick={() => deleteGroup(name, members)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>

                <Button
                  className="w-full"
                  disabled={launchBusy || activeCount === 0}
                  onClick={() => launchGroup(name, members)}
                  title={
                    activeCount === 0
                      ? "No active profiles to launch"
                      : `Launch all ${activeCount} active profile${
                          activeCount === 1 ? "" : "s"
                        } (3 tries each on error)`
                  }
                >
                  {launchingGroup === name ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4 mr-1.5" />
                  )}
                  {launchingGroup === name ? "Launching…" : `Launch group (${activeCount} active)`}
                </Button>

                {members.length > 0 ? (
                  <div className="space-y-1">
                    {members.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <PriorityStar priority={p.profile_priority} />
                            <span
                              className={cn(
                                "truncate text-[12.5px]",
                                p.is_active === false && "text-muted-foreground line-through",
                              )}
                              title={
                                p.is_active === false
                                  ? `${p.profile_name} (inactive — skipped on group launch)`
                                  : p.profile_name
                              }
                            >
                              {p.profile_name}
                            </span>
                            {p.is_active === false && (
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                (inactive)
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                            <span className="shrink-0">
                              {p.profile_priority === "first"
                                ? "1st priority"
                                : p.profile_priority === "second"
                                  ? "2nd priority"
                                  : "No priority"}
                            </span>
                            {p.account_area && (
                              <>
                                <span>·</span>
                                <span className="truncate" title={p.account_area}>
                                  {p.account_area}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        {/* Move this profile to another group, or ungroup it. */}
                        <Select value={name} onValueChange={(v) => moveProfile(p.id, v)}>
                          <SelectTrigger
                            className="h-7 w-[132px] text-[11px]"
                            title="Move to another group"
                            disabled={busy}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {groupNames.map((g) => (
                              <SelectItem key={g} value={g}>
                                {g}
                              </SelectItem>
                            ))}
                            <SelectItem value={UNGROUP_VALUE}>— Ungroup —</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          title="Launch this profile (3 tries on error)"
                          disabled={launchBusy || p.is_active === false}
                          onClick={() => launchOne(p)}
                        >
                          {launchingProfileId === p.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Rocket className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          title={`Remove from ${name}`}
                          disabled={busy}
                          onClick={() => removeProfile(p.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground">
                    No profiles assigned yet. Add some below.
                  </p>
                )}

                <AddProfilesPanel
                  groupName={name}
                  candidates={profiles.filter((p) => p.group_name !== name)}
                  busy={busy}
                  onAdd={(ids) => assignProfiles(name, ids)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Per-group multi-select to assign profiles. Candidates include profiles from
 * other groups (assigning moves them), each showing its current group. */
function AddProfilesPanel({
  groupName,
  candidates,
  busy,
  onAdd,
}: {
  groupName: string;
  candidates: Profile[];
  busy: boolean;
  onAdd: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? candidates.filter(
          (p) =>
            p.profile_name.toLowerCase().includes(q) ||
            p.incogniton_profile_id.toLowerCase().includes(q) ||
            (p.account_area ?? "").toLowerCase().includes(q),
        )
      : candidates;
    return [...list].sort((a, b) => a.profile_name.localeCompare(b.profile_name));
  }, [candidates, query]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!open)
    return (
      <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Add profiles
      </Button>
    );

  return (
    <div className="rounded-md border bg-background p-2 space-y-2">
      <div className="relative">
        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search profiles to add…"
          className="h-8 pl-8"
        />
      </div>
      <div className="max-h-48 overflow-auto rounded border divide-y">
        {filtered.length === 0 ? (
          <p className="p-3 text-center text-[12px] text-muted-foreground">No profiles found.</p>
        ) : (
          filtered.map((p) => (
            <label
              key={p.id}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] cursor-pointer hover:bg-muted/40"
            >
              <Checkbox checked={picked.has(p.id)} onCheckedChange={() => toggle(p.id)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <PriorityStar priority={p.profile_priority} />
                  <span className="truncate">{p.profile_name}</span>
                </div>
                <span className="block truncate text-[10.5px] text-muted-foreground">
                  {p.profile_priority === "first"
                    ? "1st priority"
                    : p.profile_priority === "second"
                      ? "2nd priority"
                      : "No priority"}
                  {p.account_area ? ` · ${p.account_area}` : ""}
                </span>
              </div>
              {p.group_name && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
                  in {p.group_name}
                </span>
              )}
            </label>
          ))
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setPicked(new Set());
            setQuery("");
          }}
        >
          Done
        </Button>
        <Button
          size="sm"
          disabled={busy || picked.size === 0}
          onClick={() => {
            onAdd([...picked]);
            setPicked(new Set());
          }}
        >
          Add {picked.size > 0 ? picked.size : ""} to {groupName}
        </Button>
      </div>
    </div>
  );
}

function ExportDialog({
  open,
  profiles,
  groups,
  onClose,
}: {
  open: boolean;
  profiles: Profile[];
  groups: string[];
  onClose: () => void;
}) {
  const [group, setGroup] = useState(groups[0] ?? "__all__");
  const [format, setFormat] = useState<FileFormat>("xlsx");
  const [exporting, setExporting] = useState(false);

  async function download() {
    setExporting(true);
    try {
      const rows =
        group === "__all__" ? profiles : profiles.filter((p) => (p.group_name ?? "") === group);
      if (rows.length === 0) {
        toast.error("No profiles in this group");
        return;
      }
      await downloadProfiles(`incogniton-${group}`, format, rows.map(toSheetRow));
      toast.success(`Exported ${rows.length} profile${rows.length === 1 ? "" : "s"}`);
      onClose();
    } catch (error) {
      console.error("[Export profiles] Failed:", error);
      toast.error(error instanceof Error ? error.message : "Could not export profiles");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !exporting && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export Profiles</DialogTitle>
          <DialogDescription>Download profiles as an XLSX or CSV file.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="block mb-1.5">Group</Label>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All profiles</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="block mb-1.5">Format</Label>
            <Select value={format} onValueChange={(value) => setFormat(value as FileFormat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="xlsx">XLSX</SelectItem>
                <SelectItem value="csv">CSV</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={exporting}>
            Cancel
          </Button>
          <Button onClick={download} disabled={exporting}>
            {exporting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Export
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="block mb-1.5 text-[12px]">{label}</Label>
      {children}
    </div>
  );
}
