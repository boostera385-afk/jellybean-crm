import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  canExplore,
  detailSchema,
  explorerRequestSchema,
  filterPayload,
  nodeSchema,
  pageSchema,
  serviceCatalog,
  summarySchema,
} from "@/lib/lead-explorer";
import type { AppRole } from "@/hooks/use-auth";
import type { Json } from "@/integrations/supabase/types";

const PRIORITY: AppRole[] = [
  "admin",
  "sub_admin",
  "cs_admin",
  "fb_admin",
  "scraping",
  "maturing",
  "cs",
  "acc_handler",
  "facebook",
  "seo",
];
const catalog = serviceCatalog();

// POST keeps customer search text out of request URLs, browser history and SSR URLs.
export const queryLeadExplorer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(explorerRequestSchema)
  .handler(async ({ data, context }) => {
    const roles = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roles.error) throw new Error(roles.error.message);
    const primary =
      PRIORITY.find((role) => roles.data?.some((entry) => entry.role === role)) ?? null;
    if (!canExplore(primary)) throw new Error("Forbidden");
    const response = await context.supabase.rpc("lead_explorer_query", {
      p_action: data.action,
      p_group: data.group,
      p_path: data.path,
      p_filters: filterPayload(data.filters) as Json,
      p_catalog: catalog,
      p_cursor: data.cursor,
      p_lead_id: data.leadId ?? undefined,
    });
    if (response.error) throw new Error(response.error.message);
    switch (data.action) {
      case "nodes":
        return { action: "nodes" as const, value: nodeSchema.array().parse(response.data) };
      case "summary":
        return { action: "summary" as const, value: summarySchema.parse(response.data) };
      case "detail":
        return { action: "detail" as const, value: detailSchema.parse(response.data) };
      case "results":
        return { action: "results" as const, value: pageSchema.parse(response.data) };
    }
  });
