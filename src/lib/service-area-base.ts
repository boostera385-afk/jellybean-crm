import { supabase } from "@/integrations/supabase/client";
import { findServiceCategory } from "@/lib/service-assignment";

// Role groups the Service/Area Base applies to.
export type BaseRole = "fb" | "seo" | "nd";
export type EnforcementMode = "warn" | "status";
export type ServiceScope = "category" | "service";

export const BASE_ROLES: BaseRole[] = ["fb", "seo", "nd"];

export const BASE_ROLE_LABEL: Record<BaseRole, string> = {
  fb: "FB (Facebook)",
  seo: "SEO",
  nd: "ND (Maturing / Sub-admin)",
};

// Which actual app roles each submitter maps to for base checks.
export function roleToBaseGroup(role: string | null | undefined): BaseRole | null {
  if (role === "facebook" || role === "fb_admin") return "fb";
  if (role === "seo") return "seo";
  if (role === "maturing" || role === "sub_admin") return "nd";
  return null;
}

export type ServiceAreaBase = {
  id: string;
  role_group: BaseRole;
  service_scope: ServiceScope;
  service_value: string;
  state_code: string;
  city: string | null;
  active_from: string | null; // YYYY-MM-DD
  active_to: string | null; // YYYY-MM-DD
  enforcement_mode: EnforcementMode;
  created_by: string | null;
  created_at: string;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isBaseActive(base: ServiceAreaBase, today: string = todayKey()): boolean {
  if (base.active_from && today < base.active_from) return false;
  if (base.active_to && today > base.active_to) return false;
  return true;
}

// A lead is "in base" when there are no active rules for its role group, or when
// at least one active rule matches its service + state (+ city).
export function isLeadInBase(params: {
  bases: ServiceAreaBase[];
  service: string | null | undefined;
  stateCode: string | null | undefined;
  city: string | null | undefined;
  today?: string;
}): boolean {
  const today = params.today ?? todayKey();
  const active = params.bases.filter((b) => isBaseActive(b, today));
  if (active.length === 0) return true; // no active base → no restriction

  const svc = (params.service ?? "").trim().toLowerCase();
  const category =
    (params.service ? findServiceCategory(params.service) : null)?.toLowerCase() ?? null;
  const st = (params.stateCode ?? "").trim().toUpperCase();
  const cty = (params.city ?? "").trim().toLowerCase();

  return active.some((b) => {
    const serviceOk =
      b.service_scope === "service"
        ? b.service_value.trim().toLowerCase() === svc
        : category !== null && b.service_value.trim().toLowerCase() === category;
    if (!serviceOk) return false;

    if (b.state_code.trim().toUpperCase() !== st) return false;

    // No city on the rule = whole state is acceptable.
    const ruleCity = (b.city ?? "").trim().toLowerCase();
    if (!ruleCity) return true;
    return cty.length > 0 && cty.includes(ruleCity);
  });
}

export async function fetchBasesForRole(group: BaseRole): Promise<ServiceAreaBase[]> {
  const { data, error } = await supabase
    .from("service_area_bases" as never)
    .select("*")
    .eq("role_group", group);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ServiceAreaBase[];
}

export async function fetchAllBases(): Promise<ServiceAreaBase[]> {
  const { data, error } = await supabase
    .from("service_area_bases" as never)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ServiceAreaBase[];
}

// Enforcement is configured per rule. A lead that falls outside every active
// rule is moved to the Out of Base status when ANY active rule for its role is
// set to "status"; otherwise it's warn-only. (With the common single-rule
// setup this is simply that rule's own action.)
export function resolveEnforcement(
  bases: ServiceAreaBase[],
  today: string = todayKey(),
): EnforcementMode {
  return bases.some((b) => isBaseActive(b, today) && b.enforcement_mode === "status")
    ? "status"
    : "warn";
}

export const OUT_OF_BASE_STATUS = "out_of_base";
