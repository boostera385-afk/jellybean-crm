// JellyBean CS Pipeline Status Definitions
export const STATUS_LABEL: Record<string, string> = {
  new: "New to contact",
  undeliver: "Undeliver",
  wrong_number: "Wrong Number",
  wrong_lead: "Wrong Lead",
  // Compatibility labels for legacy clients; new writes are normalized by the DB.
  wrong_service: "Wrong Lead",
  wrong_person: "Wrong Number",
  already_got_someone: "Already Got Someone",
  already_received_before: "Already received before",
  service_provider_himself: "Service Provider Himself",
  small_service: "Wrong Lead",
  converted: "Delivered",
  cx_interested: "CX interested",
  cx_not_interested: "CX not interested",
  cx_didnt_replied: "CX didn't replied",
  need_follow_up: "Need Follow Up",
  out_of_base: "Out of Base",
  called: "Called",
  messaged: "Messaged",
  follow_up: "Follow-up",
  interested: "Interested",
  not_interested: "Not interested",
  already_done: "Already done",
  no_response: "No response",
  closed_won: "Closed (done)",
  closed_lost: "Closed (lost)",
};

// Using explicit Tailwind colors to ensure classes are not purged at build time
export const STATUS_TONE: Record<string, string> = {
  cx_interested: "bg-success/10 text-success border-success/30 shadow-sm",
  cx_not_interested: "bg-destructive/10 text-destructive border-destructive/30 shadow-sm",
  cx_didnt_replied: "bg-warning/10 text-warning border-warning/30 shadow-sm",
  new: "bg-[#e8edf3] text-[#1e3a5f] border-[#d7dee7] shadow-sm",
  undeliver: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  wrong_number: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  wrong_lead: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  wrong_service: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  wrong_person: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  already_got_someone: "bg-[#efefec] text-[#74766B] border-[#d5d6cf] shadow-sm",
  already_received_before: "bg-[#efefec] text-[#74766B] border-[#d5d6cf] shadow-sm",
  service_provider_himself: "bg-[#efefec] text-[#74766B] border-[#d5d6cf] shadow-sm",
  small_service: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  converted: "bg-[#def7e8] text-[#07B053] border-[#a9dfbf] shadow-sm",
  need_follow_up: "bg-[#fff5d5] text-[#8f6a00] border-[#f1d27a] shadow-sm",
  out_of_base: "bg-[#fde8d5] text-[#b4530a] border-[#f4c79a] shadow-sm",
  called: "bg-[#e8edf3] text-[#1e3a5f] border-[#d7dee7] shadow-sm",
  messaged: "bg-[#e8edf3] text-[#1e3a5f] border-[#d7dee7] shadow-sm",
  follow_up: "bg-[#fff5d5] text-[#8f6a00] border-[#f1d27a] shadow-sm",
  interested: "bg-[#e8edf3] text-[#1e3a5f] border-[#d7dee7] shadow-sm",
  not_interested: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  already_done: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
  closed_won: "bg-[#def7e8] text-[#07B053] border-[#a9dfbf] shadow-sm",
  closed_lost: "bg-[#f8e4e5] text-[#C1292E] border-[#e7b1b3] shadow-sm",
};

/** Follow-up is manual-only; suppress old suggestions during rolling deploys too. */
export function canShowAiSuggestion(manualStatus: string, suggestedStatus: string | null): boolean {
  return (
    manualStatus !== "need_follow_up" &&
    !["need_follow_up", "wrong_person", "wrong_service", "small_service"].includes(
      suggestedStatus ?? "",
    )
  );
}

/**
 * A pinned important lead is a "handle this first" marker for a brand new lead,
 * so the pin is consumed as soon as CS moves the lead out of `new`.
 *
 * The database owns this rule (trg_qualified_leads_pin_only_while_new). This
 * mirrors it for payloads assembled on the client - notably the Google Sheets
 * sync, which is built from in-memory lead state and would otherwise report a
 * pin the database has already cleared.
 */
export function pinnedImportantFor(
  pinnedImportant: boolean | null | undefined,
  csStatus: string | null | undefined,
): boolean {
  return Boolean(pinnedImportant) && csStatus === "new";
}
