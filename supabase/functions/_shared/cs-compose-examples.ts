/**
 * Drafts the CS team corrected by hand, shown to the review step as examples.
 *
 * Two sources:
 *   SEED     the 22 corrections the team sent in Nov 2026, written into code;
 *   saved    corrections captured since then (cs_compose_corrections), when an
 *            agent edits an AI draft before sending it.
 *
 * The seed keeps the team's wording; only typos and grammar were fixed
 * ("fo" -> "for", "need to install" -> "need to be installed").
 *
 * Names are masked: "{name}" is the customer, "{agent}" the sender. A saved
 * correction is only used when it still has the team's message form and holds
 * nothing that looks like contact details, so an agent pasting a phone number
 * or an unrelated note into the draft never becomes an example.
 *
 * No database, env or SDK imports.
 */
import { stem, tokens } from "./cs-context-grounding.ts";

export type CorrectionExample = {
  service: string;
  draft: string;
  corrected: string;
};

const ask = "so I can check the schedule for a visit?";

export const SEED_CORRECTIONS: CorrectionExample[] = [
  {
    service: "Drywall Repair",
    draft: `Hi {name}, we had a conversation on Nextdoor regarding drywall repair service. Could you kindly share a picture of the drywall that needs to be repaired and the size of the drywall area that needs to be repaired, ${ask}`,
    corrected: `Hi {name}, we had a conversation on Nextdoor regarding drywall repair service. Could you kindly share a picture of the drywall that needs to be repaired and the size of the drywall area in sq ft, ${ask}`,
  },
  {
    service: "Garage Door Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a garage door repair service. Could you kindly let me know if you already have the replacement spring and share your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a garage door repair service for spring replacement. Could you kindly let me know if you already have the replacement spring and share your complete address, ${ask}`,
  },
  {
    service: "Carpet Cleaning",
    draft: `Hi {name}, we had a conversation on Facebook regarding carpet cleaning service. Could you kindly share some pictures and let me know the size, ${ask}`,
    corrected: `Hi {name}, we had a conversation on Facebook regarding carpet cleaning service. Could you kindly let me know the size and share a picture of the carpet area, ${ask}`,
  },
  {
    service: "Gutter Cleaning",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a gutter cleaning service. Could you kindly share the size of the house and your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a gutter cleaning service for a double story house. Could you kindly share the size of the house and your complete address, ${ask}`,
  },
  {
    service: "Moving",
    draft: `Hi {name}, we had a conversation on Facebook regarding transport service for playground swingsets. Could you kindly share some pictures and your complete address, ${ask}`,
    corrected: `Hi {name}, we had a conversation on Facebook regarding transport service for playground swingsets. Could you kindly share pictures of the assembling items and your complete address, ${ask}`,
  },
  {
    service: "Garage Door Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a garage door repair service. Could you kindly let me know what issue you are facing with your garage door wheel popped off in the middle and your availability, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a garage door repair service because one of the wheels popped off. Could you kindly let me know what issue you are facing with your garage door wheel popped off in the middle and your availability, ${ask}`,
  },
  {
    service: "Govee Lights Installation",
    draft: `Hi {name}, we had a conversation on Facebook regarding Govee Lights installation. Could you kindly let me know what exactly needs to be done for your Govee Lights installation and share some pictures, ${ask}`,
    corrected: `Hi {name}, we had a conversation on Facebook regarding Govee Lights installation service. Could you kindly share a picture of the house where the lights need to be installed and let me know if you already have the lights, ${ask}`,
  },
  {
    service: "Garage Door Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a garage door repair service. Could you kindly share a picture of the garage door and let me know your availability, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a garage door repair service. Could you kindly let me know what issue you are facing with your garage door and share your complete address, ${ask}`,
  },
  {
    service: "Moving",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a local moving service. Could you kindly share pictures of the items that need to be moved and the complete pickup and drop off addresses, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a moving service. Could you kindly share pictures of the items that need to be moved and the complete pickup and drop off addresses, ${ask}`,
  },
  {
    service: "Window Cleaning",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a window cleaning service. Could you kindly let me know how many windows need to be cleaned and share your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a window cleaning service. Could you kindly let me know how many windows need to be cleaned and share a picture of the windows, ${ask}`,
  },
  {
    service: "Dryer Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a dryer repair service. Could you kindly let me know what issue you are facing with the dryer and your availability, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a dryer repair service. Could you kindly let me know what issue you are facing with the dryer and share the brand name of the dryer, ${ask}`,
  },
  {
    service: "Siding Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a siding repair and improvement service. Could you kindly let me know what exactly needs to be done and share your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a siding repair service. Could you kindly share a picture of the siding area that needs to be repaired and let me know your availability, ${ask}`,
  },
  {
    service: "Appliance Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for an appliance repair service. Could you kindly share the issue you are facing and your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for an appliance repair service. Could you kindly let me know which appliance you want to repair and share your complete address, ${ask}`,
  },
  {
    service: "Carpet Cleaning",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a carpet cleaning service. Could you kindly share a picture of the carpet area and your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a carpet cleaning service. Could you kindly share a picture of the carpet area and let me know the size, ${ask}`,
  },
  {
    service: "Microwave Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a microwave repair service. Could you kindly send me a picture of the microwave and share the brand name of the microwave, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a microwave repair service. Could you kindly let me know what issue you are facing with your microwave and share the brand name of the microwave, ${ask}`,
  },
  {
    service: "Holiday Light Installation",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a holiday light installation service. Could you kindly share a picture of where you want to install the Christmas lights, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a holiday light installation service. Could you kindly share a picture of where you want to install the Christmas lights and let me know if you already have the lights, ${ask}`,
  },
  {
    service: "Popcorn Ceiling Repair",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for an ac unit and popcorn ceiling repair service. Could you kindly share the issue you are facing with your popcorn ceiling and your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for an ac unit and popcorn ceiling repair service. Could you kindly share a picture of the popcorn ceiling that needs to be repaired and let me know the ceiling height, ${ask}`,
  },
  {
    service: "Electrician",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for an electrician to replace a ceiling fan with a new fixture. Could you kindly let me know if you already have the replacement fan and share your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for an electrician to replace a ceiling fan with a new fixture. Could you kindly let me know if you already have the replacement fan and share a picture of the area where the fan needs to be installed, ${ask}`,
  },
  {
    service: "Dryer Vent Cleaning",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a dryer vent cleaning service. Could you kindly share a picture of the dryer vent and your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a dryer vent cleaning service. Could you kindly let me know your availability and share your complete address, ${ask}`,
  },
  {
    service: "Rug Cleaning",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a rug cleaning service. Could you kindly share a picture of the rug area and your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a rug cleaning service. Could you kindly share a picture of the rug area and let me know the size, ${ask}`,
  },
  {
    service: "Christmas Light Installation",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a permanent Christmas light installation service. Could you kindly share a picture of the area circled in red where you would like the lights installed and your complete address, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a permanent Christmas light installation service. Could you kindly share a picture of the area where the lights need to be installed and let me know if you already have the lights, ${ask}`,
  },
  {
    service: "Handyman",
    draft: `Hi {name}, this is {agent}. I saw that you are looking for a handyman service to hang a large picture. Could you kindly share some pictures and let me know what exactly needs to be done, ${ask}`,
    corrected: `Hi {name}, this is {agent}. I saw that you are looking for a handyman service to hang a large picture. Could you kindly share pictures of the area where the picture needs to be hung and let me know the size of the picture, ${ask}`,
  },
];

/** The draft with the customer's first name and the sender's name masked. */
export function maskNames(text: string, customerName: string | null | undefined): string {
  const first = (customerName ?? "").trim().split(/\s+/)[0] ?? "";
  let out = text.trim();
  if (first && /^[\p{L}\p{M}'’.-]+$/u.test(first)) {
    const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "giu"), "{name}");
  }
  return out.replace(/\b(this is )[\p{L}'’-]+/iu, "$1{agent}");
}

/**
 * A saved correction worth showing: still the team's message form, different
 * from the draft, and free of anything that looks like contact details.
 */
export function usableCorrection(example: CorrectionExample): boolean {
  const { draft, corrected } = example;
  if (!corrected || corrected === draft || corrected.length > 600) return false;
  if (!/^Hi \{name\},/.test(corrected) || !/\bCould you kindly\b/.test(corrected)) return false;
  if (!/\?$/.test(corrected.trim())) return false;
  // Phone numbers, street numbers, emails, links.
  if (/\d{3,}|@|https?:|www\./i.test(corrected)) return false;
  return true;
}

const words = (text: string) => new Set(tokens(text).map(stem));
const STOP = words(
  "a an the and or of for to in on with service services hi name agent this is i saw that you are looking could kindly share let me know so can check schedule visit",
);

/** The kind of work, which says less about the questions than the item does. */
const JOB_WORDS = words("repair installation install cleaning clean replacement removal moving");
/** Items the team asks about the same way: a rug is asked about like a
 *  carpet, a fridge like a dryer or a microwave. */
const ALIKE: string[][] = [
  ["rug", "carpet"],
  ["holiday", "christmas", "light", "govee"],
  [
    "appliance",
    "fridge",
    "refrigerator",
    "freezer",
    "dryer",
    "washer",
    "microwave",
    "oven",
    "stove",
    "dishwasher",
  ],
].map((group) => [...words(group.join(" "))]);

/**
 * The examples most like this lead: same kind of job first, judged by the
 * words of its service and opening. Saved corrections come before the seed on
 * a tie, as they are the team's most recent judgement.
 */
export function pickExamples(
  service: string | null | undefined,
  serviceContext: string,
  saved: CorrectionExample[] = [],
  limit = 6,
): CorrectionExample[] {
  const base = [...words(`${service ?? ""} ${serviceContext}`)].filter((w) => !STOP.has(w));
  const alike = new Set(
    ALIKE.filter((group) => group.some((w) => base.includes(w)))
      .flat()
      .filter((w) => !base.includes(w)),
  );
  const want = [...base, ...alike];
  const pool = [...saved.filter(usableCorrection), ...SEED_CORRECTIONS];
  const scored = pool.map((example, index) => {
    const have = words(`${example.service} ${example.corrected.split("Could you kindly")[0]}`);
    // Service-name matches count double: "carpet cleaning" vs "rug cleaning".
    const serviceWords = words(example.service);
    const score = want.reduce((sum, word) => {
      const weight = JOB_WORDS.has(word) ? 0.5 : alike.has(word) ? 0.75 : 1;
      return sum + weight * ((have.has(word) ? 1 : 0) + (serviceWords.has(word) ? 1 : 0));
    }, 0);
    return { example, score, index };
  });
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter(({ example }) => {
      if (seen.has(example.corrected)) return false;
      seen.add(example.corrected);
      return true;
    })
    .slice(0, limit)
    .map(({ example }) => example);
}
