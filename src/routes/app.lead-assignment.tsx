import { useState, useMemo, useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { RouteSkeleton } from "@/components/route-skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { confirmDialog } from "@/components/confirm-dialog-store";
import { listCsTeam } from "@/lib/cs-team.functions";
import { ServiceAssignmentTab } from "@/components/service-assignment-tab";
import {
  listStateAssignments,
  upsertStateAssignments,
  removeStateAssignment,
  getStateAnalytics,
  getCsUserTotals,
  type StateAssignmentRow,
} from "@/lib/lead-assignment.functions";
import { US_STATES, US_STATE_NAME } from "@/lib/us-states";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/lead-statuses";

export const Route = createFileRoute("/app/lead-assignment")({
  head: () => ({
    meta: [
      { title: "Lead Assignment \u00b7 JellyBean" },
      {
        name: "description",
        content: "Manage customer service lead routing and assignment totals.",
      },
      { property: "og:title", content: "Lead Assignment \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Manage customer service lead routing and assignment totals.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
});

type Preset = "today" | "7d" | "30d" | "custom";

function rangeFor(
  preset: Preset,
  customFrom: string,
  customTo: string,
): { from: string | null; to: string | null } {
  if (preset === "custom") {
    return {
      from: customFrom ? new Date(customFrom).toISOString() : null,
      to: customTo ? new Date(new Date(customTo).getTime() + 86400_000).toISOString() : null,
    };
  }
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const days = preset === "today" ? 1 : preset === "7d" ? 7 : 30;
  const from = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (days - 1),
  ).toISOString();
  return { from, to };
}

function Page() {
  const { primaryRole } = useAuth();
  return (
    <>
      <PageHeader
        title="Lead Assignment"
        description="Route incoming leads to CS users by state or service, and monitor assignment performance."
      />
      <PageBody>
        <RoleGate allow={["admin", "cs_admin"]} current={primaryRole}>
          <LeadAssignmentInner />
        </RoleGate>
      </PageBody>
    </>
  );
}

function LeadAssignmentInner() {
  const [tab, setTab] = useState<"assignments" | "service-assignment" | "analytics">("assignments");
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
      <TabsList>
        <TabsTrigger value="assignments">State Assignments</TabsTrigger>
        <TabsTrigger value="service-assignment">Service Assignment</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
      </TabsList>
      <TabsContent value="assignments" className="mt-4">
        <AssignmentsTab />
      </TabsContent>
      <TabsContent value="service-assignment" className="mt-4">
        {tab === "service-assignment" ? <ServiceAssignmentTab /> : null}
      </TabsContent>
      <TabsContent value="analytics" className="mt-4">
        {tab === "analytics" ? <AnalyticsTab /> : null}
      </TabsContent>
    </Tabs>
  );
}

function AssignmentsTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(listStateAssignments);
  const teamFn = useServerFn(listCsTeam);
  const removeFn = useServerFn(removeStateAssignment);

  const rowsQ = useQuery({
    queryKey: ["state-assignments"],
    queryFn: () => listFn(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const teamQ = useQuery({
    queryKey: ["cs-team-for-assignment"],
    queryFn: () => teamFn(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<StateAssignmentRow | null>(null);

  const removeMut = useMutation({
    mutationFn: (state_code: string) => removeFn({ data: { state_code } }),
    onSuccess: () => {
      toast.success("Assignment removed");
      qc.invalidateQueries({ queryKey: ["state-assignments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleRemove(row: StateAssignmentRow) {
    const ok = await confirmDialog({
      title: `Remove ${row.state_name}?`,
      description:
        "New leads from this state will no longer route automatically. Existing leads are not reassigned.",
      confirmText: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    removeMut.mutate(row.state_code);
  }

  return (
    <div className="glass-card p-4 md:p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-muted-foreground">
          {rowsQ.isLoading
            ? "Loading assignments…"
            : rowsQ.isError
              ? "Unable to load assignments"
              : `${rowsQ.data?.length ?? 0} state${rowsQ.data?.length === 1 ? "" : "s"} assigned`}
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="w-4 h-4 mr-1" /> Assign States
        </Button>
      </div>
      {rowsQ.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-destructive">Failed to load state assignments</div>
            <div className="text-muted-foreground text-xs mt-1 break-words">
              {(rowsQ.error as Error)?.message ?? "Unknown error"}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => rowsQ.refetch()}
            disabled={rowsQ.isFetching}
          >
            {rowsQ.isFetching ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            Retry
          </Button>
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>State</TableHead>
                <TableHead>Assigned CS User</TableHead>
                <TableHead className="text-right">Total Leads</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowsQ.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                    Loading…
                  </TableCell>
                </TableRow>
              ) : (rowsQ.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground text-sm">
                    No states assigned yet.
                  </TableCell>
                </TableRow>
              ) : (
                rowsQ.data!.map((r) => (
                  <TableRow key={r.state_code}>
                    <TableCell className="font-medium">
                      {r.state_name}{" "}
                      <span className="text-muted-foreground text-xs">({r.state_code})</span>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{r.cs_user_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{r.cs_user_email ?? ""}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.total_leads}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(r);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5 mr-1" /> Change
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRemove(r)}
                          disabled={removeMut.isPending}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <AssignDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        team={teamQ.data ?? []}
        existing={rowsQ.data ?? []}
        editing={editing}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["state-assignments"] });
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

function AssignDialog({
  open,
  onOpenChange,
  team,
  existing,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  team: { user_id: string; full_name: string; email: string }[];
  existing: StateAssignmentRow[];
  editing: StateAssignmentRow | null;
  onSaved: () => void;
}) {
  const upsertFn = useServerFn(upsertStateAssignments);
  const [csUserId, setCsUserId] = useState<string>(editing?.assigned_cs_user_id ?? "");
  const [selectedCodes, setSelectedCodes] = useState<string[]>(editing ? [editing.state_code] : []);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setCsUserId(editing?.assigned_cs_user_id ?? "");
    setSelectedCodes(editing ? [editing.state_code] : []);
    setFilter("");
  }, [editing, open]);

  const takenByOther = useMemo(() => {
    const map = new Map<string, StateAssignmentRow>();
    for (const r of existing) {
      if (!editing || r.state_code !== editing.state_code) map.set(r.state_code, r);
    }
    return map;
  }, [existing, editing]);

  const filtered = US_STATES.filter(
    (s) =>
      !filter ||
      s.name.toLowerCase().includes(filter.toLowerCase()) ||
      s.code.toLowerCase().includes(filter.toLowerCase()),
  );

  const mut = useMutation({
    mutationFn: async () => {
      if (!csUserId) throw new Error("Pick a CS user");
      if (selectedCodes.length === 0) throw new Error("Select at least one state");
      const assignments = selectedCodes.map((code) => ({
        state_code: code,
        state_name: US_STATE_NAME[code]!,
        cs_user_id: csUserId,
      }));
      return upsertFn({ data: { assignments } });
    },
    onSuccess: () => {
      toast.success("Assignments saved");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function toggle(code: string) {
    setSelectedCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Change assignment — ${editing.state_name}` : "Assign States"}
          </DialogTitle>
          <DialogDescription>
            Select a CS user and one or more states. Reassigning a state affects only future
            incoming leads; existing leads keep their current owner.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-auto">
          <div>
            <label className="text-xs font-medium text-muted-foreground">CS User</label>
            <Select value={csUserId} onValueChange={setCsUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a CS user" />
              </SelectTrigger>
              <SelectContent>
                {team.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted-foreground">States</label>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="h-8 w-40"
              />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 max-h-72 overflow-auto pr-1">
              {filtered.map((s) => {
                const taken = takenByOther.get(s.code);
                const selected = selectedCodes.includes(s.code);
                return (
                  <button
                    type="button"
                    key={s.code}
                    onClick={() => toggle(s.code)}
                    className={`text-left text-xs rounded-md border px-2.5 py-1.5 transition-colors ${
                      selected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background hover:bg-muted"
                    }`}
                    title={
                      taken
                        ? `Currently assigned to ${taken.cs_user_name ?? taken.cs_user_email ?? "another CS"}`
                        : undefined
                    }
                  >
                    <div className="font-medium">{s.name}</div>
                    <div
                      className={`text-[10px] ${selected ? "opacity-80" : "text-muted-foreground"}`}
                    >
                      {s.code}
                      {taken ? ` · ${taken.cs_user_name ?? taken.cs_user_email ?? "assigned"}` : ""}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="text-[11px] text-muted-foreground mt-2">
              Reassigning a state currently owned by another CS will transfer it to the selected
              user for future leads only.
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AnalyticsTab() {
  const [preset, setPreset] = useState<Preset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const range = rangeFor(preset, customFrom, customTo);

  const stateFn = useServerFn(getStateAnalytics);
  const userFn = useServerFn(getCsUserTotals);

  const stateQ = useQuery({
    queryKey: ["state-analytics", range.from, range.to],
    queryFn: () => stateFn({ data: { from: range.from, to: range.to } }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const userQ = useQuery({
    queryKey: ["cs-user-totals", range.from, range.to],
    queryFn: () => userFn({ data: { from: range.from, to: range.to } }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const statusKeys = Object.keys(STATUS_LABEL);

  return (
    <div className="space-y-4">
      <div className="glass-card p-3 flex flex-wrap items-center gap-2">
        {(["today", "7d", "30d", "custom"] as Preset[]).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={preset === p ? "default" : "outline"}
            onClick={() => setPreset(p)}
          >
            {p === "today"
              ? "Today"
              : p === "7d"
                ? "Last 7 Days"
                : p === "30d"
                  ? "Last 30 Days"
                  : "Custom"}
          </Button>
        ))}
        {preset === "custom" && (
          <>
            <Input
              type="date"
              className="h-8 w-40"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span className="text-muted-foreground text-xs">to</span>
            <Input
              type="date"
              className="h-8 w-40"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </>
        )}
      </div>

      {(stateQ.isError || userQ.isError) && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-destructive">Failed to load analytics</div>
            <div className="text-muted-foreground text-xs mt-1 break-words">
              {((stateQ.error as Error) ?? (userQ.error as Error))?.message ?? "Unknown error"}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (stateQ.isError) stateQ.refetch();
              if (userQ.isError) userQ.refetch();
            }}
            disabled={stateQ.isFetching || userQ.isFetching}
          >
            {stateQ.isFetching || userQ.isFetching ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
            ) : null}
            Retry
          </Button>
        </div>
      )}

      <div className="glass-card p-4">
        <div className="text-sm font-semibold mb-3">Per-State Breakdown</div>
        <div className="overflow-auto max-h-[520px]">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="min-w-40">State</TableHead>
                <TableHead>CS User</TableHead>
                <TableHead className="text-right">Total</TableHead>
                {statusKeys.map((k) => (
                  <TableHead key={k} className="text-right whitespace-nowrap">
                    {STATUS_LABEL[k]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stateQ.isLoading ? (
                <TableRow>
                  <TableCell colSpan={3 + statusKeys.length} className="text-center py-6">
                    <Loader2 className="w-4 h-4 inline animate-spin" />
                  </TableCell>
                </TableRow>
              ) : (stateQ.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3 + statusKeys.length}
                    className="text-center py-6 text-sm text-muted-foreground"
                  >
                    No assignments yet.
                  </TableCell>
                </TableRow>
              ) : (
                stateQ.data!.map((r) => (
                  <TableRow key={r.state_code}>
                    <TableCell className="font-medium">
                      {r.state_name}{" "}
                      <span className="text-xs text-muted-foreground">({r.state_code})</span>
                    </TableCell>
                    <TableCell className="text-sm">{r.cs_user_name ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {r.total_leads}
                    </TableCell>
                    {statusKeys.map((k) => {
                      const v = r.by_status?.[k] ?? 0;
                      return (
                        <TableCell key={k} className="text-right tabular-nums">
                          {v > 0 ? (
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded border text-xs ${STATUS_TONE[k] ?? ""}`}
                            >
                              {v}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="glass-card p-4">
        <div className="text-sm font-semibold mb-3">CS User Totals</div>
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>CS User</TableHead>
                <TableHead>Assigned States</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead>Leads by State</TableHead>
                <TableHead>Leads by Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userQ.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6">
                    <Loader2 className="w-4 h-4 inline animate-spin" />
                  </TableCell>
                </TableRow>
              ) : (userQ.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-sm text-muted-foreground">
                    No data for this range.
                  </TableCell>
                </TableRow>
              ) : (
                userQ.data!.map((u) => (
                  <TableRow key={u.cs_user_id}>
                    <TableCell>
                      <div className="text-sm font-medium">{u.cs_user_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{u.cs_user_email ?? ""}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-64">
                        {u.assigned_states.map((c) => (
                          <Badge key={c} variant="secondary" className="text-[10px]">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {u.total_leads}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-green-600">
                      {u.processed_leads}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{u.pending_leads}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-72">
                        {Object.entries(u.by_state).map(([code, n]) => (
                          <span
                            key={code}
                            className="text-[10px] px-1.5 py-0.5 rounded border bg-muted/50"
                          >
                            {code}: <span className="font-medium tabular-nums">{n}</span>
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-80">
                        {Object.entries(u.by_status).map(([k, n]) => (
                          <span
                            key={k}
                            className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_TONE[k] ?? ""}`}
                          >
                            {STATUS_LABEL[k] ?? k}:{" "}
                            <span className="font-medium tabular-nums">{n}</span>
                          </span>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
