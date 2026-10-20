/**
 * The one-click compose suggestion.
 *
 * The templates below are team-editable text with three placeholders. Until
 * now only two were ever substituted: `(Requirement)` was left in the message
 * verbatim, and `(Service Context)` was replaced with the whole raw context
 * sentence, so the chip inserted things like
 *
 *   "Hi John, this is Alex. I saw that you are looking for Customer needs
 *    refrigerator repair, not cooling.. Could you kindly (Requirement), so I
 *    can check the schedule for a visit?"
 *
 * All three are now filled from the ask catalogue generated from the team's
 * delivered messages, the same source the AI composer uses, so the chip needs
 * no model call and still asks the question that sub-category asks - minus
 * anything the customer already told us.
 */
import { detect, normalizeSource } from "../../supabase/functions/_shared/cs-detect";
import { selectAsks, wordingFor } from "../../supabase/functions/_shared/cs-ask-policy";
import {
  joinAsks,
  noFurtherServiceRequested,
  referralPlatform,
  NO_SERVICE_ACKNOWLEDGMENT,
} from "../../supabase/functions/_shared/cs-composer";
import { CS_ASK_CATALOGUE } from "../../supabase/functions/_shared/cs-ask-catalogue.generated";

export const CS_COMPOSE_TEMPLATE_KEY = "cs_compose_template";

export const DEFAULT_CS_COMPOSE_TEMPLATE =
  "Hi (Person first name), this is Alex. I saw that you are looking for (Service Context). Could you kindly (Requirement), so I can check the schedule for a visit?";

export const COMPOSE_TEMPLATES = [
  {
    id: "schedule_visit",
    name: "Schedule Visit",
    template:
      "Hi (Person first name), this is Alex. I saw that you are looking for (Service Context). Could you kindly (Requirement), so I can check the schedule for a visit?",
  },
  {
    id: "price_estimate",
    name: "Request Estimate Details",
    template:
      "Hello (Person first name), I saw your request for (Service Context). Could you kindly share your details so we can get you a price estimate?",
  },
  {
    id: "call_request",
    name: "Call Request",
    template:
      "Hi (Person first name), this is Alex. I saw that you are looking for (Service Context). What is the best number or time to call you to discuss details and check the schedule?",
  },
  {
    id: "follow_up",
    name: "Quick Follow-up",
    template:
      "Hi (Person first name), checking in regarding your request for (Service Context). Are you still looking to get this scheduled?",
  },
] as const;

export function firstName(fullName: string | null | undefined) {
  return fullName?.trim().split(/\s+/)[0] || "there";
}

/** After "regarding" the team drops the indefinite article. */
const dropArticle = (phrase: string) => phrase.replace(/^(?:an?)\s+/i, "");

export type SuggestionLead = {
  customer_name?: string | null;
  service?: string | null;
  context?: string | null;
  pass_it_to?: string | null;
  post_text?: string | null;
  main_area?: string | null;
  sub_area?: string | null;
  cs_notes?: unknown;
  requirement_1?: string | null;
  requirement_2?: string | null;
  reference?: string | null;
};

/** The sources the detectors may read. Outgoing drafts and the suggested
 *  requirements are deliberately absent: they are not customer answers. */
function leadSources(lead: SuggestionLead): string[] {
  const notes = Array.isArray(lead.cs_notes)
    ? lead.cs_notes
        .map((note) =>
          note && typeof note === "object" && "text" in note
            ? String((note as { text: unknown }).text ?? "")
            : "",
        )
        .filter(Boolean)
    : [];
  return [lead.post_text, lead.context, lead.main_area, lead.sub_area, ...notes].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

/** How the team names a job done to a thing: "a refrigerator repair service". */
const ACTION_NOUNS: Record<string, string> = {
  repair: "repair",
  install: "installation",
  replace: "replacement",
  clean: "cleaning",
  remove: "removal",
  move: "moving",
  maintain: "maintenance",
};
/** Trades the team names directly rather than as "<x> service". */
const TRADES =
  /^(?:plumber|electrician|handyman|locksmith|roofer|painter|carpenter|technician|contractor|mover|movers|cleaner|exterminator)$/;

const article = (phrase: string) => (/^[aeiou]/i.test(phrase) ? "an" : "a");

function fromService(service: string | null | undefined): string {
  const clean = normalizeSource(service ?? "").replace(/^general\s+/, "");
  if (!clean) return "";
  if (/^movers$/.test(clean)) return "movers";
  if (TRADES.test(clean)) return `${article(clean)} ${clean}`;
  const withNoun = /\bservices?$/.test(clean) ? clean.replace(/s$/, "") : `${clean} service`;
  return `${article(withNoun)} ${withNoun}`;
}

function fromDetectedJob(lead: SuggestionLead): string {
  const sources = leadSources(lead);
  if (!sources.length) return "";
  const detection = detect(sources);
  const object = detection.objects[0];
  if (!object) return "";
  const label = CS_ASK_CATALOGUE.objectLabels[object]?.[0];
  if (!label) return "";
  const action = detection.action ? ACTION_NOUNS[detection.action] : undefined;
  const phrase = action ? `${label} ${action} service` : `${label} service`;
  return `${article(phrase)} ${phrase}`;
}

/** Last resort: the customer's own words, reduced to a phrase that reads
 *  correctly after "looking for" instead of a whole pasted sentence. */
function fromContext(lead: SuggestionLead): string {
  const raw = (lead.context || lead.post_text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const phrase = raw
    .replace(/^(?:hi|hello|hey)\b[^.!?]*?[,.]\s*/i, "")
    .replace(
      /^(?:customer\s+|i\s*(?:'m|am)\s+|we\s*(?:'re|are)\s+|i\s+|we\s+)?(?:is\s+|just\s+)?(?:looking (?:for|to)|searching for|seeking|in need of|need(?:s|ed)?|want(?:s|ed)?|requires?|trying to find)\s+/i,
      "",
    )
    .split(/[.!?;]|,\s+(?:and|but|so)\b/)[0]
    .trim()
    .replace(/^(?:a|an|the)\s+/i, "");
  // At least two words: a bare noun like "help" gives "a help", which is the
  // kind of broken phrase this whole function exists to stop.
  if (!/\s/.test(phrase) || phrase.length < 8 || phrase.length > 90) return "";
  // Raw post text carries brackets, questions and addresses. Anything that is
  // not a clean phrase is dropped rather than pasted after "looking for".
  if (/[()[\]{}<>@]|\d{3,}|\?/.test(phrase)) return "";
  if (/^(?:do|does|did|can|could|would|will|is|are|who|what|where|when|how)\b/i.test(phrase))
    return "";
  return `${article(phrase)} ${phrase.toLowerCase()}`;
}

/**
 * The noun phrase that completes "I saw that you are looking for ___".
 *
 * The lead's own `service` column is preferred because it is the team's own
 * classification; the detected job is next, then the customer's words trimmed
 * to a phrase. "your service" only survives when the lead has nothing at all.
 */
export function serviceContextForLead(lead: SuggestionLead) {
  return (
    fromService(lead.service) ||
    fromDetectedJob(lead) ||
    fromContext(lead) ||
    // THE ONE PHRASE IN THIS SYSTEM NOT TAKEN FROM THE DELIVERED MESSAGES.
    // Reached on 0.41% of the export (114 of 27,558 rows): no service column,
    // no identifiable object, and a context too short to make a phrase from.
    // On those rows the team wrote a trade it had inferred by hand ("a
    // handyman", "an electrician"), so there is no house wording to copy and
    // guessing a trade would assert something we do not know. This is
    // grammatical, claims nothing and invents no detail; change the wording
    // freely, it is a copy decision rather than a measured one.
    "the service you need"
  );
}

/**
 * The asks, in the team's own wording.
 *
 * Catalogue first: it knows what this sub-category asks and drops anything the
 * customer already supplied. The lead's stored `requirement_1/2` are used only
 * when the catalogue has nothing to offer, and the catalogue's own no-object
 * fallback (scope, then address) is the floor - so the placeholder can never
 * reach a customer.
 */
export function requirementForLead(lead: SuggestionLead) {
  const sources = leadSources(lead);
  if (noFurtherServiceRequested(sources)) return "";
  if (sources.length) {
    const detection = detect(sources);
    const selection = selectAsks(
      detection,
      lead.service,
      detection.objects[0] ?? null,
      normalizeSource(sources.join("\n")),
    );
    // No padding from stale stored requirements or a scope/address fallback
    // after the catalogue has deliberately suppressed already-known answers.
    return joinAsks(selection.asks.map((ask) => ask.fragment));
  }
  const stored = [lead.requirement_1, lead.requirement_2]
    .map((value) => (value ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (stored.length) return joinAsks(stored);
  const floor = [wordingFor("SCOPE", null), wordingFor("ADDRESS", null)].filter(
    (phrase): phrase is string => Boolean(phrase),
  );
  return joinAsks(floor);
}

/** Any placeholder a template carries that we cannot fill, e.g. one the team
 *  invented in a custom template. Dropped rather than sent to a customer. */
const UNFILLED_PLACEHOLDER = /\s*\([^)]*\)/g;

export function renderCsComposeSuggestion(template: string, lead: SuggestionLead) {
  if (noFurtherServiceRequested(leadSources(lead)))
    return `Hi ${firstName(lead.customer_name)}, this is Alex. ${NO_SERVICE_ACKNOWLEDGMENT}`;
  const requirements = requirementForLead(lead);
  if (!requirements && /\(Requirement\)/i.test(template)) {
    const withoutQuestion = template.replace(
      /\s*Could you kindly \(Requirement\), so I can check the schedule for a visit\?/i,
      "",
    );
    // Do not guess how to repair an unknown custom template's empty clause.
    if (/\(Requirement\)/i.test(withoutQuestion)) return "";
    template = withoutQuestion;
  }
  // A lead whose Reference records a conversation is not introduced again, so
  // the greeting and intro clause are swapped for the team's referral opening
  // before the placeholders are filled. The asks and the closing are untouched.
  const platform = referralPlatform(lead.reference);
  if (platform) {
    template = template.replace(
      /^(?:Hi|Hello)\s*\(Person first name\)\s*,.*?(?=Could you kindly|$)/i,
      `Hi (Person first name), we had a conversation on ${platform} regarding (Service Context). `,
    );
  }
  return (
    template
      .replace(/\(Person first name\)/gi, firstName(lead.customer_name))
      .replace(
        /\(Service Context\)/gi,
        platform ? dropArticle(serviceContextForLead(lead)) : serviceContextForLead(lead),
      )
      .replace(/\(Requirement\)/gi, requirements)
      .replace(/\(Sender\)/gi, "Alex")
      .replace(UNFILLED_PLACEHOLDER, "")
      .replace(/\s{2,}/g, " ")
      // A removed placeholder can leave its connector stranded ("service -,").
      .replace(/\s*[\u2014\u2013-]\s*([.,?!])/g, "$1")
      .replace(/\s+([.,?!])/g, "$1")
      .replace(/([.,])\1+/g, "$1")
      .trim()
  );
}
