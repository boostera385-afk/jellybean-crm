/**
 * Why a lead is in Need Review, from qualified_leads.ai_review_reason.
 * `short` fits on the card badge; `detail` is the hover text.
 */
type ReviewReason = { short: string; detail: string };

const REASONS: Record<string, ReviewReason> = {
  ambiguous_conversation: {
    short: "Unclear reply",
    detail: "The customer's reply could not be read as a clear outcome.",
  },
  needs_human_review: { short: "Check chat", detail: "The AI asked a person to check the chat." },
  delivery_not_confirmed: {
    short: "Not delivered yet",
    detail: "Quo has not confirmed the message was delivered.",
  },
  delivery_failed: { short: "Delivery failed", detail: "Quo reports the message failed delivery." },
  no_matching_quo_history: {
    short: "No Quo chat",
    detail: "No Quo messages or calls were found for this number.",
  },
  unmatched: {
    short: "No Quo chat",
    detail: "No Quo messages or calls were found for this number.",
  },
  no_contact_yet: { short: "Not contacted", detail: "Nothing has been sent to this customer yet." },
  customer_wrote_first: {
    short: "Texted before lead",
    detail: "This number was texting with us before the lead was created.",
  },
  contacted_before_lead: {
    short: "Texted before lead",
    detail: "This number was texting with us before the lead was created.",
  },
  media_requires_review: { short: "Photo reply", detail: "The customer replied with an image." },
  media_reply_interested: { short: "Photo reply", detail: "The customer replied with an image." },
  phone_shared_between_leads: {
    short: "Shared number",
    detail: "This phone number belongs to more than one lead.",
  },
  invalid_or_excess_customer_numbers: {
    short: "Check numbers",
    detail: "The customer numbers are invalid or too many.",
  },
  history_too_large: {
    short: "Chat too long",
    detail: "The chat was too long for the AI to read.",
  },
};

const AI_ERRORS = new Set([
  "error",
  "model_unavailable",
  "invalid_model_response",
  "invalid_checkpoint",
]);
const MAX_SHORT = 22;

export function reviewReason(code: string | null | undefined): ReviewReason | null {
  const key = (code ?? "").trim();
  if (!key) return null;
  const known = REASONS[key];
  if (known) return known;
  if (AI_ERRORS.has(key))
    return { short: "AI error", detail: "The AI check failed; it will retry." };
  if (key.startsWith("quo_") || key.startsWith("no_quo") || key.startsWith("invalid_quo")) {
    return { short: "Quo error", detail: "Quo could not be read for this lead." };
  }
  const words = key.replace(/_/g, " ");
  const short = words.length > MAX_SHORT ? `${words.slice(0, MAX_SHORT - 1).trimEnd()}…` : words;
  return { short: short.charAt(0).toUpperCase() + short.slice(1), detail: words };
}
