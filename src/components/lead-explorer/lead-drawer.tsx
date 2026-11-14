import { Link } from "@tanstack/react-router";
import { ExternalLink, MapPin, Phone } from "lucide-react";
import { z } from "zod";
import { useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useExplorerQuery } from "@/hooks/use-lead-explorer";
import { locationPath, type ExplorerFilters, type ExplorerGroup } from "@/lib/lead-explorer";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/lead-statuses";
import { formatPhone } from "@/lib/crm-lite";
import { formatPKT } from "@/lib/timezone";
import { friendlyError } from "@/lib/error-messages";
import { cn } from "@/lib/utils";

export function LeadDrawer({
  leadId,
  group,
  filters,
  close,
}: {
  leadId?: string;
  group: ExplorerGroup;
  filters: ExplorerFilters;
  close: () => void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const query = useExplorerQuery("detail", group, [], filters, !!leadId, leadId ?? null);
  const lead = query.data?.action === "detail" ? query.data.value : null;
  const notes = z
    .array(z.object({ at: z.string(), by: z.string(), text: z.string() }))
    .safeParse(lead?.cs_notes);
  return (
    <Sheet
      open={!!leadId}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        className="!w-full !max-w-none overflow-y-auto sm:!max-w-xl"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus({ preventScroll: true });
          }
        }}
      >
        <SheetHeader className="pr-7">
          <p className="crm-kicker">Qualified lead</p>
          <SheetTitle className="break-words">{lead?.customer_name || "Lead details"}</SheetTitle>
          <SheetDescription>
            Read-only preview. Open CS Pipeline to work this lead.
          </SheetDescription>
        </SheetHeader>
        {query.isPending && <Skeleton className="mt-6 h-64 w-full" />}
        {query.isError && (
          <div role="alert" className="mt-6 space-y-2">
            <p>{friendlyError(query.error)}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry details
            </Button>
          </div>
        )}
        {query.isSuccess && !lead && (
          <p role="status" className="mt-6 text-sm text-muted-foreground">
            Lead not found or no longer available to your account.
          </p>
        )}
        {lead && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "crm-pill-text rounded-full border px-2 py-1",
                  STATUS_TONE[lead.cs_status],
                )}
              >
                {STATUS_LABEL[lead.cs_status] ?? lead.cs_status}
              </span>
              {lead.is_important && <span className="text-xs text-warning">Important</span>}
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="crm-lead-label">Service</p>
                <p className="mt-1 break-words">{lead.service || "Unspecified service"}</p>
              </div>
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="break-words">{locationPath(lead)}</span>
              </p>
              {[lead.customer_number, lead.customer_number_2]
                .filter((number): number is string => !!number)
                .map((number, index) => (
                  <p key={index} className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <a
                      href={`tel:${number.replace(/[^\d+]/g, "")}`}
                      className="rounded text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {formatPhone(number)}
                    </a>
                  </p>
                ))}
              <p className="text-muted-foreground">Created {formatPKT(lead.created_at)} PKT</p>
              {lead.followup_at && (
                <p className="text-muted-foreground">Follow-up {formatPKT(lead.followup_at)} PKT</p>
              )}
            </div>
            <section>
              <h3 className="crm-section-title">Context</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                {lead.context || lead.post_text || "No context recorded."}
              </p>
            </section>
            <section>
              <h3 className="crm-section-title">CS notes</h3>
              {notes.success && notes.data.length ? (
                <div className="mt-2 space-y-3">
                  {notes.data.map((note, index) => (
                    <div key={index} className="rounded-lg border border-border p-3">
                      <p className="whitespace-pre-wrap break-words text-sm">{note.text}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {note.by} ·{" "}
                        {Number.isNaN(Date.parse(note.at)) ? note.at : formatPKT(note.at)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No previewable notes recorded.</p>
              )}
            </section>
            <Button asChild className="w-full">
              <Link to="/app/cs-leads" search={{ leadId: lead.id }}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Open in CS Pipeline
              </Link>
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
