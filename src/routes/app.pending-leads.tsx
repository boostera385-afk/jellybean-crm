import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Bell,
  BellRing,
  Check,
  ExternalLink,
  Loader2,
  MapPin,
  Phone,
  RefreshCw,
} from "lucide-react";

import { RouteSkeleton } from "@/components/route-skeleton";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/error-messages";
import { formatPhone } from "@/lib/crm-lite";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/lead-statuses";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/pending-leads")({
  head: () => ({
    meta: [
      { title: "Pending Leads \u00b7 JellyBean" },
      { name: "description", content: "Review customer leads requiring reminder follow-up." },
      { property: "og:title", content: "Pending Leads \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Review customer leads requiring reminder follow-up.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  pendingComponent: () => <RouteSkeleton />,
  pendingMs: 200,
});

type PendingLead = {
  lead_id: string;
  customer_name: string;
  customer_number: string;
  main_area: string | null;
  sub_area: string | null;
  cs_status: string;
  assigned_to: string | null;
  reminder_count: number;
  last_reminder_at: string;
  last_message: string | null;
};

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Pending leads"
        description="Leads with an active reminder. Acknowledge one to clear it for everyone."
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
  const qc = useQueryClient();
  const navigate = useNavigate();

  const list = useQuery({
    queryKey: ["pending-reminder-leads"],
    queryFn: async () => {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
        ) => Promise<{ data: PendingLead[] | null; error: { message: string } | null }>
      )("list_pending_reminder_leads");
      if (error) throw new Error(error.message);
      return (data ?? []) as PendingLead[];
    },
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Keep the list live: any reminder insert/read that the current user can see
  // nudges a refetch (the count/list themselves come from SECURITY DEFINER RPCs).
  useEffect(() => {
    const channel = supabase
      .channel(`pending-leads-page-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "lead_reminders" }, () => {
        void qc.invalidateQueries({ queryKey: ["pending-reminder-leads"] });
        void qc.invalidateQueries({ queryKey: ["pending-reminders-count"] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc]);

  async function acknowledge(leadId: string) {
    try {
      const { error } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ error: { message: string } | null }>
      )("acknowledge_lead_reminders", { _lead_id: leadId });
      if (error) throw new Error(error.message);
      toast.success("Reminder acknowledged");
      void qc.invalidateQueries({ queryKey: ["pending-reminder-leads"] });
      void qc.invalidateQueries({ queryKey: ["pending-reminders-count"] });
    } catch (err) {
      toast.error(friendlyError(err));
    }
  }

  const rows = list.data ?? [];

  return (
    <div className="space-y-4">
      <div className="crm-toolbar-panel">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
            <BellRing className="h-4 w-4 text-warning" />
            <span className="font-medium text-foreground">{rows.length}</span> lead
            {rows.length === 1 ? "" : "s"} awaiting acknowledgement
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => qc.invalidateQueries({ queryKey: ["pending-reminder-leads"] })}
            disabled={list.isFetching}
          >
            {list.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {list.error && (
        <div className="text-[12.5px] text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {(list.error as Error).message}
        </div>
      )}

      {list.isLoading && !list.data ? (
        <div className="crm-section-panel">
          <div className="glass-card p-16 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading...
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="crm-section-panel">
          <div className="glass-card p-10 text-center text-[12.5px] text-muted-foreground">
            <Bell className="h-5 w-5 mx-auto mb-2 opacity-50" />
            No pending reminders right now.
          </div>
        </div>
      ) : (
        <div className="crm-section-panel">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="crm-data-table">
              <thead className="bg-surface text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Customer</th>
                  <th className="text-left px-3 py-2 font-medium">Phone</th>
                  <th className="text-left px-3 py-2 font-medium">Area</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Reminder</th>
                  <th className="text-left px-3 py-2 font-medium">Sent</th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lead_id} className="crm-data-row border-t border-border">
                    <td className="px-3 py-2 font-semibold text-foreground">{r.customer_name}</td>
                    <td className="px-3 py-2">
                      <a
                        href={`tel:${r.customer_number}`}
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary"
                      >
                        <Phone className="h-3 w-3" /> {formatPhone(r.customer_number)}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {r.sub_area || r.main_area ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {r.sub_area || r.main_area}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "text-[10.5px] px-2.5 py-1 rounded-full border font-medium shadow-sm",
                          STATUS_TONE[r.cs_status] ??
                            "bg-muted text-muted-foreground border-border",
                        )}
                      >
                        {STATUS_LABEL[r.cs_status] ?? r.cs_status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground max-w-[320px]">
                      <div className="truncate" title={r.last_message ?? undefined}>
                        {r.last_message || "-"}
                      </div>
                      {r.reminder_count > 1 && (
                        <div className="text-[11px] crm-muted-text">
                          +{r.reminder_count - 1} earlier
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground tabular-nums whitespace-nowrap">
                      {formatDistanceToNow(new Date(r.last_reminder_at), { addSuffix: true })}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() =>
                            void navigate({
                              to: "/app/cs-leads",
                              search: { leadId: r.lead_id },
                            })
                          }
                          title="Open lead in CS pipeline"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => void acknowledge(r.lead_id)}
                          title="Acknowledge — clears this lead from Pending for everyone"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
