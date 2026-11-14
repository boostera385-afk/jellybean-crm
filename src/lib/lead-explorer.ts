import { z } from "zod";
import { SERVICE_CATEGORIES } from "@/data/service-options";
import { normalizeLeadService } from "@/lib/service-assignment";
import type { AppRole } from "@/hooks/use-auth";
import { Constants } from "@/integrations/supabase/types";

export const EXPLORER_ROLES: AppRole[] = ["admin", "cs_admin", "cs"];
export const PAGE_SIZE = 50;
export const MISSING_KEY = "missing";
export const UNMAPPED_KEY = "unmapped";
export const groupSchema = z.enum(["area", "service"]);
const branchKeySchema = z
  .string()
  .max(2000)
  .refine(
    (key) => key === MISSING_KEY || key === UNMAPPED_KEY || key.startsWith("v:"),
    "Invalid branch key",
  );
const daySchema = z.string().date();
export const explorerSearchSchema = z
  .object({
    group: groupSchema.catch("area").default("area"),
    view: z.enum(["list", "diagram"]).catch("list").default("list"),
    path: z.array(branchKeySchema).max(3).catch([]).default([]),
    from: daySchema.optional().catch(undefined),
    to: daySchema.optional().catch(undefined),
    status: z.enum(Constants.public.Enums.cs_status).optional().catch(undefined),
    owner: z.enum(["all", "mine", "unassigned"]).catch("all").default("all"),
    important: z.boolean().catch(false).default(false),
    due: z.boolean().catch(false).default(false),
    leadId: z.string().uuid().optional().catch(undefined),
  })
  .transform((value) => ({
    ...value,
    path: value.path.slice(0, value.group === "area" ? 3 : 2),
  }));
export type ExplorerSearch = z.infer<typeof explorerSearchSchema>;
export type ExplorerGroup = z.infer<typeof groupSchema>;

export const explorerFiltersSchema = z
  .object({
    query: z.string().trim().max(160).default(""),
    from: daySchema.optional(),
    to: daySchema.optional(),
    status: z.enum(Constants.public.Enums.cs_status).optional(),
    owner: z.enum(["all", "mine", "unassigned"]).default("all"),
    important: z.boolean().default(false),
    due: z.boolean().default(false),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, "Start date must precede end date");
export type ExplorerFilters = z.infer<typeof explorerFiltersSchema>;
export const cursorSchema = z.object({
  created_at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});
export type ExplorerCursor = z.infer<typeof cursorSchema>;
export const explorerRequestSchema = z
  .object({
    action: z.enum(["nodes", "summary", "results", "detail"]),
    group: groupSchema,
    path: z.array(branchKeySchema).max(3),
    filters: explorerFiltersSchema,
    cursor: cursorSchema.nullable().default(null),
    leadId: z.string().uuid().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.path.length > (value.group === "area" ? 3 : 2)) {
      ctx.addIssue({ code: "custom", message: "Invalid branch depth", path: ["path"] });
    }
    if (value.action === "detail" && !value.leadId) {
      ctx.addIssue({ code: "custom", message: "Lead ID required", path: ["leadId"] });
    }
  });
export type ExplorerRequest = z.infer<typeof explorerRequestSchema>;

export function branchKey(value: string | null | undefined): string {
  return value == null || value.trim() === "" ? MISSING_KEY : `v:${value}`;
}
export function branchLabel(group: ExplorerGroup, depth: number, key: string): string {
  if (key === UNMAPPED_KEY) return "Unmapped services";
  if (key !== MISSING_KEY) return key.slice(2);
  return group === "service"
    ? "Unspecified service"
    : (["Unknown state", "Unspecified area", "Unspecified sub-area"][depth] ?? "Unspecified");
}
export function branchId(group: ExplorerGroup, path: string[]): string {
  return JSON.stringify([group, ...path]);
}
export function canExplore(role: AppRole | null): boolean {
  return role !== null && EXPLORER_ROLES.includes(role);
}
// Keep the first catalog category, exactly as findServiceCategory does.
export function serviceCatalog(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const category of SERVICE_CATEGORIES) {
    for (const service of category.services) {
      const key = normalizeLeadService(service);
      if (key && !Object.hasOwn(result, key)) result[key] = category.category;
    }
  }
  return result;
}
const catalogLookup = serviceCatalog();
export function serviceCategoryKey(value: string | null): string {
  const key = normalizeLeadService(value);
  if (!key) return MISSING_KEY;
  const category = Object.hasOwn(catalogLookup, key) ? catalogLookup[key] : undefined;
  return category ? branchKey(category) : UNMAPPED_KEY;
}
export function locationPath(lead: {
  state_code: string | null;
  main_area: string | null;
  sub_area: string | null;
}): string {
  return [lead.state_code, lead.main_area, lead.sub_area]
    .map((value, depth) => branchLabel("area", depth, branchKey(value)))
    .join(" › ");
}
// Explorer follows application-wide PKT days; CS Pipeline's Eastern days are unchanged.
export function filterPayload(
  filters: ExplorerFilters,
): Record<string, string | boolean | undefined> {
  return {
    query: filters.query,
    date_from: filters.from ? new Date(`${filters.from}T00:00:00+05:00`).toISOString() : undefined,
    date_to: filters.to
      ? new Date(new Date(`${filters.to}T00:00:00+05:00`).getTime() + 86_400_000).toISOString()
      : undefined,
    status: filters.status,
    owner: filters.owner,
    important: filters.important,
    due: filters.due,
  };
}
export const nodeSchema = z.object({ key: z.string(), total: z.number(), new_count: z.number() });
export type ExplorerNode = z.infer<typeof nodeSchema>;
export const summarySchema = z.object({
  total: z.number(),
  new_count: z.number(),
  followup_due: z.number(),
});
export const leadSchema = z.object({
  id: z.string().uuid(),
  customer_name: z.string().nullable(),
  customer_number: z.string().nullable(),
  service: z.string().nullable(),
  state_code: z.string().nullable(),
  main_area: z.string().nullable(),
  sub_area: z.string().nullable(),
  cs_status: z.string(),
  created_at: z.string(),
  followup_at: z.string().nullable(),
  is_important: z.boolean().nullable(),
});
export type ExplorerLead = z.infer<typeof leadSchema>;
export const pageSchema = z.object({
  rows: z.array(leadSchema),
  next_cursor: cursorSchema.nullable(),
});
export const detailSchema = leadSchema
  .extend({
    customer_number_2: z.string().nullable(),
    context: z.string().nullable(),
    post_text: z.string().nullable(),
    cs_notes: z.array(z.object({ at: z.string(), by: z.string(), text: z.string() })).catch([]),
  })
  .nullable();
