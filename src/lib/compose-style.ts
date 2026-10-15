/**
 * The CS compose house style, derived from delivered leads.
 *
 * `compose-style.generated.json` is produced by scripts/build-compose-style.py
 * from an export of delivered leads. It carries the wording the team actually
 * sent, so the prompt and the post-processing agree with the real messages
 * instead of with hand-written guesses.
 *
 * Keep serviceKey() and requirementIntentKey() in step with the identically
 * named helpers in that script - the generated keys must match at runtime.
 */
import generated from "./compose-style.generated.json";

export type ComposeExemplar = {
  context: string;
  exact: string;
  service: string;
  out: { serviceContext: string; requirement1: string; requirement2: string };
};

type StyleData = {
  closing: string;
  closingShare: number;
  preferredVerbs: string[];
  canonicalRequirements: { intent: string; use: string; n: number; variants: string[] }[];
  exemplarsByService: Record<string, ComposeExemplar[]>;
  genericExemplars: ComposeExemplar[];
};

const style = generated as unknown as StyleData;

const VERB_RE = /^(share|let me know|send me|send|tell me|tell|confirm|provide)\b\s*/i;
const FILLER_RE = /\b(your|the|a|an|me|us)\b/gi;

/** Mirror of service_key() in scripts/build-compose-style.py. */
export function serviceKey(service: string | null | undefined): string {
  return (service ?? "")
    .toLowerCase()
    .replace(/\b(general|service|services|repair service)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mirror of intent_key() in scripts/build-compose-style.py. */
export function requirementIntentKey(phrase: string | null | undefined): string {
  return (phrase ?? "")
    .toLowerCase()
    .replace(/[.,;:]+$/, "")
    .replace(VERB_RE, "")
    .replace(FILLER_RE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const canonicalByIntent = new Map(style.canonicalRequirements.map((c) => [c.intent, c.use]));

/**
 * Snap a requirement onto the team's majority wording for the same ask.
 *
 * Replaces the previous hardcoded rules, which forced every picture request to
 * "send me a picture of it" - wording that appears nowhere in the delivered
 * messages, where the object is always named ("share a picture of the area").
 * Anything with no majority form is left as the model wrote it, only tidied.
 */
export function canonicalizeRequirement(requirement: string | null | undefined): string {
  const raw = (requirement ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const canonical = canonicalByIntent.get(requirementIntentKey(raw));
  const out = canonical ?? raw;
  return (out.charAt(0).toLowerCase() + out.slice(1)).replace(/[.?,;!]$/, "").trim();
}

/** A few real delivered examples for this service, best match first. */
export function selectComposeExemplars(
  service: string | null | undefined,
  limit = 6,
): ComposeExemplar[] {
  const key = serviceKey(service);
  const picked: ComposeExemplar[] = [];
  if (key) {
    const exact = style.exemplarsByService[key];
    if (exact) picked.push(...exact);
    if (picked.length < limit) {
      const tokens = new Set(key.split(" ").filter((t) => t.length > 2));
      const scored = Object.entries(style.exemplarsByService)
        .filter(([k]) => k !== key)
        .map(([k, v]) => {
          const kt = k.split(" ").filter((t) => t.length > 2);
          const overlap = kt.filter((t) => tokens.has(t)).length;
          return { v, score: overlap / Math.max(kt.length, 1), overlap };
        })
        .filter((s) => s.overlap > 0)
        .sort((a, b) => b.score - a.score);
      for (const s of scored) {
        picked.push(...s.v);
        if (picked.length >= limit) break;
      }
    }
  }
  if (picked.length === 0) picked.push(...style.genericExemplars);
  return picked.slice(0, limit);
}

/**
 * The system prompt, written from the delivered messages.
 *
 * Supersedes the hand-written prompt, which asked for a bare service name and
 * banned the word "service" - the opposite of the delivered style, where the
 * phrase names the service AND the customer's specific item or problem.
 */
export function buildComposeSystemPrompt(): string {
  const rules = style.canonicalRequirements
    .slice(0, 24)
    .map((c) => `- ${c.intent} -> "${c.use}"`)
    .join("\n");
  return `You prepare the three variable parts of an outbound SMS for a home-services lead.
The app wraps your output in this exact sentence, so write only the parts:

  "Hi {name}, this is {agent}. I saw that you are looking for {serviceContext}. Could you kindly {requirement1} and {requirement2}, so I can ${style.closing}?"

Return a JSON object with exactly: serviceContext, requirement1, requirement2.

serviceContext
- Name the service AND the customer's specific item or problem, as the team writes it.
- Start with "a" or "an", and keep the word "service" where it reads naturally.
- Good: "a garage door repair service to repair an off track roll up garage door"
- Good: "an appliance repair service for your outdoor refrigerator"
- Good: "a window replacement service to replace two windows and the frames"
- Bad (too bare): "garage door repair"
- Never invent details the lead does not mention.

requirement1 and requirement2
- Two different things to ask the customer, lowercase, no trailing punctuation.
- Open with one of: ${style.preferredVerbs.map((v) => `"${v}"`).join(", ")}.
- Name the object rather than saying "it": "share a picture of the area", not "send me a picture of it".
- The two asks must not overlap. Address is the most common second ask.
- Use exactly this wording when the ask is one of these:
${rules}

Never use: "I understand", "seeking", "repair or replacement", "damaged or non-functioning", "provide the service address", "our schedule", "arrange a visit".`;
}

export const COMPOSE_STYLE_META = generated as unknown as { _meta: Record<string, unknown> };
