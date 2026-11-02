// Shared helper: submit a saved draft directly to CS from the Drafts
// dialog. Reuses the same qualified_leads insert shape as the raw-leads
// QualifyDialog.send() and submit-lead.submit() flows so we don't
// duplicate business logic across surfaces.

import { supabase } from "@/integrations/supabase/client";
import { formatPhone } from "@/lib/crm-lite";
import { extractNextdoorPostId, canonicalizeLeadLink } from "@/lib/lead-link-canonicalizer";
import { FACEBOOK_LEAD_REFERENCE } from "@/lib/lead-form-utils";
import type { LeadDraft } from "@/lib/lead-drafts";
import { autoRephraseLeadWithAi } from "@/lib/raw-leads-ai.functions";

export class DraftValidationError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(
      `Required fields are missing. Open the draft and complete all required information before sending it to CS.\nMissing: ${missing.join(", ")}`,
    );
    this.name = "DraftValidationError";
    this.missing = missing;
  }
}

export type SendDraftContext = {
  userId: string;
  actorName: string | null;
  actorRole: string | null;
};

// Required fields mirror LeadForm.handleSubmit(). Area is required for
// every source except manual-seo drafts (matches app.submit-lead's
// `areaRequired={role !== "seo"}` gate).
function validateDraft(draft: LeadDraft, role: string | null): void {
  const f = draft.form_data ?? {};
  const areaRequired = !(draft.source_type === "manual_lead" && role === "seo");

  const missing: string[] = [];
  const req = (label: string, val: unknown) => {
    if (typeof val !== "string" || val.trim() === "") missing.push(label);
  };
  req("Customer name", f.customerName);
  req("Customer number", f.customerNumber);
  if (areaRequired) req("Area", f.area);
  req("Service", f.service);
  req("Context", f.context);
  req("Exact customer text", f.exactCustomerText);
  if (!(draft.source_type === "manual_lead" && (role === "facebook" || role === "fb_admin"))) {
    req("Reference", f.reference);
  }
  if (missing.length > 0) throw new DraftValidationError(missing);
}

export async function sendDraftToCS(draft: LeadDraft, ctx: SendDraftContext): Promise<void> {
  const f = draft.form_data ?? {};
  const isRaw = draft.source_type === "raw_lead";
  const role = isRaw
    ? ((f.role as string | undefined) ?? ctx.actorRole ?? null)
    : (ctx.actorRole ?? (f.role as string | undefined) ?? null);
  validateDraft(draft, role);

  const customerName = String(f.customerName).trim();
  const customerNumberRaw = String(f.customerNumber).trim();
  const customerNumber = formatPhone(customerNumberRaw) || customerNumberRaw;
  const area = ((f.area as string) ?? "").trim();
  const service = String(f.service).trim();
  const context = String(f.context).trim();
  const postText = String(f.exactCustomerText).trim();
  const reference =
    !isRaw && (role === "facebook" || role === "fb_admin")
      ? FACEBOOK_LEAD_REFERENCE
      : String(f.reference).trim();
  const isImportant = Boolean(f.isImportant);
  const extraNumbersRaw = (f.extraNumbers as string[] | undefined) ?? [];
  const cleanedExtras = extraNumbersRaw
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .map((p) => formatPhone(p) || p);

  // Raw-lead drafts snapshot the underlying raw_lead_cache row so we can
  // preserve original_lead_link and canonical fields.
  const snapshot =
    (f.entrySnapshot as
      { row_key?: string; id?: string | null; data?: Record<string, string> } | undefined) ??
    undefined;
  const rawRow = snapshot?.data ?? {};
  const rawLeadLink =
    (f.originalLeadLink as string | null | undefined) ?? rawRow["Lead Link"] ?? null;

  // For manual submissions we mirror app.submit-lead: pass_it_to is null for
  // facebook/seo roles; for anyone else it echoes the service. For raw leads
  // pass_it_to always equals service, matching QualifyDialog.send().
  const passItTo = isRaw ? service : role === "facebook" || role === "seo" ? null : service;

  const insertPayload: Record<string, unknown> = {
    customer_name: customerName,
    customer_number: customerNumber,
    customer_number_2: cleanedExtras[0] ?? null,
    extra_numbers: cleanedExtras,
    service,
    pass_it_to: passItTo,
    main_area: area || null,
    sub_area: area || null,
    context,
    post_text: postText,
    reference,
    images: [],
    submitted_by_role: role,
    is_important: isImportant,
    pinned_important: isImportant,
    created_by: ctx.userId,
    assigned_by: ctx.userId,
    cs_status: "new",
    is_landline: Boolean(f.isLandline),
  };

  if (isRaw && rawLeadLink) {
    insertPayload.original_lead_link = rawLeadLink;
    insertPayload.canonical_post_id = extractNextdoorPostId(rawLeadLink);
    insertPayload.canonical_lead_link = canonicalizeLeadLink(rawLeadLink);
  }

  const { data: insertedLead, error } = await supabase
    .from("qualified_leads")
    .insert(insertPayload as never)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);

  if (insertedLead?.id) {
    void autoRephraseLeadWithAi({ data: { leadId: insertedLead.id } }).catch((err) => {
      console.error("[Auto-rephrase] Failed for draft lead:", insertedLead.id, err);
    });
  }

  // Activity log — matches shape used by both existing flows.
  await supabase.from("activity_logs").insert({
    actor_id: ctx.userId,
    actor_name: ctx.actorName,
    actor_role: ctx.actorRole,
    action: isRaw ? "raw.forwarded_to_cs" : "lead.submitted_to_cs",
    entity_type: "qualified_lead",
    metadata: {
      customer_name: customerName,
      customer_number: customerNumber,
      area: area || null,
      reference,
      submitted_by_role: role,
      from_draft: true,
    },
  });

  // For raw-lead drafts, mark the underlying raw_lead_cache row as
  // forwarded so it moves out of the working queues, mirroring what the
  // Qualify dialog does on success.
  if (isRaw && snapshot?.row_key) {
    const nowIso = new Date().toISOString();
    const { error: patchErr } = await supabase
      .from("raw_lead_cache")
      .update({
        category: "forwarded",
        categorized_by: ctx.userId,
        categorized_at: nowIso,
      } as never)
      .eq("row_key", snapshot.row_key);
    if (patchErr) {
      // Do not fail the whole send if the cache patch fails — the
      // qualified_lead is already created. Surface via console.
      console.error("[sendDraftToCS] raw_lead_cache patch failed", patchErr);
    }
  }
}
