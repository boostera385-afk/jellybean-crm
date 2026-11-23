// Auto-composes the first CS reply for a newly forwarded lead.
//
// Called by the page that forwarded the lead and by every open CS Leads page
// (realtime INSERT). The server lets only the first caller compose
// (cs_claim_auto_compose), so the others return straight away without an
// OpenAI call. The caller whose draft was saved mirrors the lead to Google
// Sheets: the draft is written on the server, so no other client syncs it.
import { supabase } from "@/integrations/supabase/client";
import { syncLeadToGoogleSheet, type LeadSyncPayload } from "@/lib/google-sheets-sync";
import { autoRephraseLeadWithAi } from "@/lib/raw-leads-ai.functions";

export async function autoComposeNewLead(leadId: string) {
  const result = await autoRephraseLeadWithAi({ data: { leadId } });
  if (result?.success) {
    const { data: lead } = await supabase
      .from("qualified_leads")
      .select("*")
      .eq("id", leadId)
      .maybeSingle();
    if (lead) void syncLeadToGoogleSheet("UPDATE", lead as unknown as LeadSyncPayload);
  }
  return result;
}
