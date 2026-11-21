/**
 * Why a lead is in Need Review, from qualified_leads.ai_review_reason.
 * `short` fits on the card badge; `detail` says what happened and `action`
 * what the reviewer should do, both shown on hover and in the CX chat.
 */
export type ReviewReason = { short: string; detail: string; action: string };

const CHECK_CHAT = "Open CX chat, read the conversation and set the status yourself.";

const NO_QUO_CHAT: ReviewReason = {
  short: "No Quo chat",
  detail: "No Quo messages or calls were found for this customer's number.",
  action: "Check the number is right, then text or call the customer and set the status.",
};
const TEXTED_BEFORE: ReviewReason = {
  short: "Texted before lead",
  detail: "This number was already texting with us before the lead was created.",
  action: "Open CX chat to see if this is an old customer, then set the status.",
};
const PHOTO_REPLY: ReviewReason = {
  short: "Photo reply",
  detail: "The customer replied with a photo, which the AI cannot judge.",
  action: "Check the photo in Quo, then set the status yourself.",
};

const REASONS: Record<string, ReviewReason> = {
  ambiguous_conversation: {
    short: "Unclear reply",
    detail: "The customer replied, but the AI could not tell if they are interested or not.",
    action: CHECK_CHAT,
  },
  needs_human_review: {
    short: "Check chat",
    detail: "The AI could not decide the status and asked a person to check.",
    action: CHECK_CHAT,
  },
  customer_intent: {
    short: "Check chat",
    detail: "The AI read the customer's reply but was not sure enough to set the status.",
    action: CHECK_CHAT,
  },
  delivery_not_confirmed: {
    short: "Not delivered yet",
    detail: 'Quo has not confirmed the text reached the customer (still "sent").',
    action: "Call the customer, or wait and check again later.",
  },
  delivery_failed: {
    short: "Delivery failed",
    detail: "Quo reports the text could not be delivered to this number.",
    action: "Check the number; set Undeliver or Wrong Number if it is bad.",
  },
  no_matching_quo_history: NO_QUO_CHAT,
  unmatched: NO_QUO_CHAT,
  no_contact_yet: {
    short: "Not contacted",
    detail: "Nothing has been sent to this customer from Quo yet.",
    action: "Text or call the customer first, then set the status.",
  },
  customer_wrote_first: TEXTED_BEFORE,
  contacted_before_lead: TEXTED_BEFORE,
  media_requires_review: PHOTO_REPLY,
  media_reply_interested: PHOTO_REPLY,
  phone_shared_between_leads: {
    short: "Shared number",
    detail: "This phone number belongs to more than one lead, so the chat may mix them.",
    action: "Open CX chat and check which lead the replies are about.",
  },
  invalid_or_excess_customer_numbers: {
    short: "Check numbers",
    detail: "The customer numbers on this lead are invalid or there are too many.",
    action: "Fix the customer number on the lead, then set the status.",
  },
  history_too_large: {
    short: "Chat too long",
    detail: "The conversation was too long for the AI to read.",
    action: CHECK_CHAT,
  },
};

const AI_ERROR: ReviewReason = {
  short: "AI error",
  detail: "The AI check did not finish (a temporary error on our side, not the customer).",
  action: "Open CX chat and set the status yourself, or wait for the automatic retry.",
};
const QUO_ERROR: ReviewReason = {
  short: "Quo error",
  detail: "Quo could not be reached or read for this lead (temporary error).",
  action: "Check the chat in Quo and set the status yourself, or wait for the retry.",
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
  if (AI_ERRORS.has(key)) return AI_ERROR;
  if (key.startsWith("quo_") || key.startsWith("no_quo") || key.startsWith("invalid_quo")) {
    return QUO_ERROR;
  }
  const words = key.replace(/_/g, " ");
  const short = words.length > MAX_SHORT ? `${words.slice(0, MAX_SHORT - 1).trimEnd()}…` : words;
  return {
    short: short.charAt(0).toUpperCase() + short.slice(1),
    detail: `The AI flagged this lead: ${words}.`,
    action: CHECK_CHAT,
  };
}
