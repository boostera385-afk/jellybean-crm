/**
 * Does a draft greet the customer by a name that is not theirs?
 *
 * A month of drafts had "George Stuhi" greeted as "Hi Graciela" and "Diana
 * Lewis" as "Hi Jacob" — mostly hand-written drafts, or a name edited after
 * the draft was composed. This only flags; it never changes the text.
 */

const GENERIC = new Set([
  "there",
  "all",
  "everyone",
  "team",
  "sir",
  "madam",
  "maam",
  "friend",
  "neighbor",
  "neighbour",
]);

const tokens = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length >= 2);

/** The name after "Hi"/"Hello"/"Hey", up to the comma or "this is". */
export function greetedName(draft: string | null | undefined): string | null {
  const match =
    /^\s*(?:hi|hello|hey|dear)\b[\s,]*([^,.!?\n]*?)\s*(?:[,.!?\n]|\bthis is\b|\bwe had\b|$)/i.exec(
      draft ?? "",
    );
  const name = match?.[1]?.trim();
  return name ? name : null;
}

/**
 * The greeted name when it does not belong to this customer, otherwise null.
 * Null too when there is nothing to judge: no greeting, a generic one ("Hi
 * there"), or a customer-name field that is not a name ("Customer Need: ...").
 */
export function greetingNameMismatch(
  draft: string | null | undefined,
  customerName: string | null | undefined,
): string | null {
  const greeted = greetedName(draft);
  if (!greeted) return null;
  const greetedTokens = tokens(greeted);
  if (!greetedTokens.length || greetedTokens.every((token) => GENERIC.has(token))) return null;
  const name = customerName ?? "";
  if (/[:;]/.test(name)) return null;
  const nameTokens = tokens(name);
  if (!nameTokens.length || nameTokens.length > 6) return null;
  const belongs = greetedTokens.some((token) =>
    nameTokens.some((part) => part === token || (token.length >= 3 && part.startsWith(token))),
  );
  return belongs ? null : greeted;
}
