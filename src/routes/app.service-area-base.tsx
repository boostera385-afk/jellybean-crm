import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, MapPin, CalendarRange, ShieldCheck, Edit3 } from "lucide-react";

import { RouteSkeleton } from "@/components/route-skeleton";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ServiceCombobox } from "@/components/service-combobox";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/error-messages";
import { SERVICE_CATEGORIES } from "@/data/service-options";
import { US_STATES } from "@/lib/us-states";
import {
  BASE_ROLES,
  BASE_ROLE_LABEL,
  type BaseRole,
  type EnforcementMode,
  type ServiceAreaBase,
  fetchAllBases,
  isBaseActive,
} from "@/lib/service-area-base";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/service-area-base")({
  head: () => ({
    meta: [
      { title: "Service Area Bases \u00b7 JellyBean" },
      { name: "description", content: "Manage the service coverage rules for lead routing." },
      { property: "og:title", content: "Service Area Bases \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Manage the service coverage rules for lead routing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
});

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Service / Area Base"
        description="Define which service + area combinations are acceptable per submitter role. Leads outside the active base are warned about and tagged Out of Base."
      />
      <PageBody className="!pt-5">
        <RoleGate allow={["admin", "cs_admin"]} current={auth.primaryRole}>
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const basesQuery = useQuery({ queryKey: ["service-area-bases"], queryFn: fetchAllBases });

  const basesByRole = useMemo(() => {
    const map: Record<BaseRole, ServiceAreaBase[]> = { fb: [], seo: [], nd: [] };
    for (const b of basesQuery.data ?? []) {
      if (map[b.role_group]) map[b.role_group].push(b);
    }
    return map;
  }, [basesQuery.data]);

  if (basesQuery.isLoading) {
    return (
      <div className="crm-section-panel">
        <div className="glass-card p-16 text-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {BASE_ROLES.map((role) => (
        <RoleSection key={role} role={role} bases={basesByRole[role]} />
      ))}
    </div>
  );
}

function RoleSection({ role, bases }: { role: BaseRole; bases: ServiceAreaBase[] }) {
  return (
    <div className="crm-section-panel space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="crm-section-title">{BASE_ROLE_LABEL[role]}</div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5" /> Out-of-base action is set per rule
        </div>
      </div>

      <BaseRuleForm role={role} />

      {bases.length === 0 ? (
        <div className="glass-card p-6 text-center text-[12.5px] text-muted-foreground">
          No base defined — every {BASE_ROLE_LABEL[role]} lead is accepted (no restriction).
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="crm-data-table">
            <thead className="bg-surface text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Service</th>
                <th className="text-left px-3 py-2 font-medium">State</th>
                <th className="text-left px-3 py-2 font-medium">City</th>
                <th className="text-left px-3 py-2 font-medium">Active window</th>
                <th className="text-left px-3 py-2 font-medium">If out of base</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bases.map((b) => (
                <RuleRow key={b.id} base={b} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RuleRow({ base }: { base: ServiceAreaBase }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const active = isBaseActive(base);

  async function remove() {
    if (!confirm("Delete this base rule?")) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("service_area_bases" as never)
        .delete()
        .eq("id", base.id);
      if (error) throw new Error(error.message);
      toast.success("Base rule deleted");
      qc.invalidateQueries({ queryKey: ["service-area-bases"] });
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const stateName = US_STATES.find((s) => s.code === base.state_code)?.name ?? base.state_code;

  return (
    <tr className="crm-data-row border-t border-border">
      <td className="px-3 py-2">
        <span className="font-medium text-foreground">{base.service_value}</span>
        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          ({base.service_scope})
        </span>
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          {stateName} ({base.state_code})
        </span>
      </td>
      <td className="px-3 py-2 text-muted-foreground">{base.city || "— whole state"}</td>
      <td className="px-3 py-2 text-muted-foreground tabular-nums">
        {base.active_from || base.active_to ? (
          <span className="inline-flex items-center gap-1">
            <CalendarRange className="h-3 w-3" />
            {base.active_from ?? "…"} → {base.active_to ?? "…"}
          </span>
        ) : (
          "Always"
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {base.enforcement_mode === "status" ? "Warn + move to status" : "Warn only"}
      </td>
      <td className="px-3 py-2">
        <span
          className={cn(
            "text-[10.5px] px-2 py-0.5 rounded-full border font-medium",
            active
              ? "bg-[#def7e8] text-[#07B053] border-[#a9dfbf]"
              : "bg-muted text-muted-foreground border-border",
          )}
        >
          {active ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={() => setEditing(true)}
            disabled={busy}
            title="Edit rule"
          >
            <Edit3 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2 text-destructive hover:text-destructive"
            onClick={() => void remove()}
            disabled={busy}
            title="Delete rule"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit base rule</DialogTitle>
            </DialogHeader>
            <BaseRuleForm role={base.role_group} base={base} onDone={() => setEditing(false)} />
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}

function BaseRuleForm({
  role,
  base,
  onDone,
}: {
  role: BaseRole;
  base?: ServiceAreaBase;
  onDone?: () => void;
}) {
  const auth = useAuth();
  const qc = useQueryClient();
  const isEdit = !!base;
  const [scope, setScope] = useState<"category" | "service">(base?.service_scope ?? "service");
  const [serviceValue, setServiceValue] = useState(
    base && base.service_scope === "service" ? base.service_value : "",
  );
  const [categoryValue, setCategoryValue] = useState(
    base && base.service_scope === "category" ? base.service_value : "",
  );
  const [stateCode, setStateCode] = useState(base?.state_code ?? "");
  const [city, setCity] = useState(base?.city ?? "");
  const [from, setFrom] = useState(base?.active_from ?? "");
  const [to, setTo] = useState(base?.active_to ?? "");
  const [enforcement, setEnforcement] = useState<EnforcementMode>(base?.enforcement_mode ?? "warn");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = scope === "category" ? categoryValue : serviceValue.trim();
    if (!value) {
      toast.error(scope === "category" ? "Pick a category" : "Pick a service");
      return;
    }
    if (!stateCode) {
      toast.error("Pick a state");
      return;
    }
    if (from && to && to < from) {
      toast.error("'Active to' must be on or after 'Active from'");
      return;
    }
    setBusy(true);
    try {
      const fields = {
        role_group: role,
        service_scope: scope,
        service_value: value,
        state_code: stateCode,
        city: city.trim() || null,
        active_from: from || null,
        active_to: to || null,
        enforcement_mode: enforcement,
      };
      if (isEdit && base) {
        const { error } = await supabase
          .from("service_area_bases" as never)
          .update(fields as never)
          .eq("id", base.id);
        if (error) throw new Error(error.message);
        toast.success("Base rule updated");
      } else {
        const { error } = await supabase
          .from("service_area_bases" as never)
          .insert({ ...fields, created_by: auth.user?.id ?? null } as never);
        if (error) throw new Error(error.message);
        toast.success("Base rule added");
        setServiceValue("");
        setCategoryValue("");
        setStateCode("");
        setCity("");
        setFrom("");
        setTo("");
      }
      qc.invalidateQueries({ queryKey: ["service-area-bases"] });
      onDone?.();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={isEdit ? "space-y-3" : "glass-card p-3.5 space-y-3"}>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Service type
          </Label>
          <Select value={scope} onValueChange={(v) => setScope(v as "category" | "service")}>
            <SelectTrigger className="h-9 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="service">Specific service</SelectItem>
              <SelectItem value="category">Whole category</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {scope === "category" ? "Category" : "Service"}
          </Label>
          {scope === "category" ? (
            <Select value={categoryValue} onValueChange={setCategoryValue}>
              <SelectTrigger className="h-9 text-[12px]">
                <SelectValue placeholder="Pick a category" />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_CATEGORIES.map((c) => (
                  <SelectItem key={c.category} value={c.category}>
                    {c.category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <ServiceCombobox value={serviceValue} onChange={setServiceValue} maxLength={120} />
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">State</Label>
          <Select value={stateCode || undefined} onValueChange={setStateCode}>
            <SelectTrigger className="h-9 text-[12px]">
              <SelectValue placeholder="Pick a state" />
            </SelectTrigger>
            <SelectContent>
              {US_STATES.map((s) => (
                <SelectItem key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            City (optional — blank = whole state)
          </Label>
          <Input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            maxLength={120}
            placeholder="e.g. Houston"
            className="h-9 text-[12px]"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Active from (optional)
          </Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 text-[12px]"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Active to (optional)
          </Label>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 text-[12px]"
          />
        </div>

        <div className="space-y-1.5 xl:col-span-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            If a lead is out of base
          </Label>
          <Select value={enforcement} onValueChange={(v) => setEnforcement(v as EnforcementMode)}>
            <SelectTrigger className="h-9 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="warn">Warn only (add + tag)</SelectItem>
              <SelectItem value="status">Warn + move to Out of Base status</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : isEdit ? (
            <Edit3 className="h-3.5 w-3.5 mr-1.5" />
          ) : (
            <Plus className="h-3.5 w-3.5 mr-1.5" />
          )}
          {isEdit ? "Save changes" : "Add base rule"}
        </Button>
      </div>
    </div>
  );
}
