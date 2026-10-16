/**
 * Shared prompt plumbing for the CS rephrase feature.
 *
 * Used by BOTH the route (prompt editor UI) and the server function
 * (raw-leads-ai.functions.ts), so they can never drift into byte-identical
 * duplicates or disagree about what counts as "customised" again.
 *
 * Empty by default: the compose prompt is built server side from the
 * delivered-lead export (see src/lib/compose-style.ts), so there is nothing
 * useful to show by default unless a human deliberately overrides it.
 */
export const DEFAULT_REPHRASE_PROMPT = "";

export const LEGACY_REPHRASE_PROMPT = `You are an expert customer service assistant. Your goal is to clean, extract, and normalize three parts of a customer lead request to prepare them for an outbound message.

You must output a JSON object containing exactly three fields:
1. "serviceContext": A very short, clean name of the service (e.g. "garage door repair", "lawn care", "plumbing leak"). It must be concise and lowercase. Never use "service", "seeking", "repair or replacement", or "damaged or non-functioning".
2. "requirement1": The first requirement or question normalized as an action-oriented phrase starting with a lowercase verb.
3. "requirement2": The second requirement or question normalized as an action-oriented phrase starting with a lowercase verb.

Normalization Rules for Requirements (both requirement1 and requirement2):
- If the requirement refers to address, location, or where to go, normalize it to: "share your complete address"
- If the requirement refers to availability, time, or when they are available, normalize it to: "let me know your availability"
- If the requirement refers to a photo, picture, image, or snapshot, normalize it to: "send me a picture of it"
- Otherwise, rephrase to start with a verb (e.g. "confirm whether you have the spring on hand").
- Requirement text must not be capitalized or end with punctuation.

Forbidden Phrases (do not use in any field):
- "I understand"
- "seeking"
- "repair or replacement"
- "damaged or non-functioning"
- "provide the service address"
- "our schedule"
- "arrange a visit"`;

/** True only when someone has deliberately written their own instructions. */
export function isCustomRephrasePrompt(prompt: string | null | undefined): boolean {
  const text = (prompt ?? "").trim();
  if (!text) return false;
  const norm = (v: string) => v.replace(/\s+/g, " ").trim();
  return norm(text) !== norm(LEGACY_REPHRASE_PROMPT);
}

/**
 * Semantics of the live input that the exemplar payloads cannot teach.
 *
 * The few-shot exemplars carry {context, exact, service} with clean summaries,
 * so the model only learns the output shape from them. These rules ride along
 * on every call — including calls with a saved custom prompt, which an admin
 * may replace at any time — because they describe how to READ the input, not
 * how to write the output. They are the anti-noise rules: the delivered
 * messages asked "let me know what issue you are facing" to customers who had
 * already stated the issue, because nothing told the model `exact` is the
 * customer's own voice.
 */
export const INPUT_SEMANTICS_ADDENDUM = `How to read the current lead's payload:
- "exact" holds the customer's own words about the job. Treat it as ground truth:
  never contradict it, never copy it verbatim, and never ask for a fact the
  customer already stated there (the problem itself, the brand or model, where
  they are, a photo they already attached).
- "context" is a normalized summary that may carry paste artifacts such as
  "Customer Need:" / "Service Needed:" labels or newlines. Never echo those
  labels into serviceContext; write one clean phrase.
- If the customer asked a direct question or asked the business to take an
  action (a call back, a visit), do not turn that into a requirement. Ask for
  the genuinely missing practical detail instead: the address, availability,
  or site access.
- The two requirements must differ and must not both be satisfied by something
  the customer already provided.`;
