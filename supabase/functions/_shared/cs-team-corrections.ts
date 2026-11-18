/**
 * Question pairs the CS team set by hand, from AI drafts they corrected
 * (Nov 2026, "Composing in CS pipeline").
 *
 * The catalogue measures what the team sent most often. These rules record
 * what the team says it SHOULD send for jobs where drafts kept going wrong:
 * a job-specific detail was swapped for "share your complete address" or
 * "your availability", a vague "share some pictures" was sent, or the second
 * question was dropped. When a rule matches, its pair is sent as written and
 * the model's question fitting is skipped, because the fitting step is where
 * most of those swaps happened.
 *
 * A fact the customer already gave is still never asked again: an answered
 * ask is dropped and the slot is filled from the catalogue's remaining asks.
 *
 * Keep each rule narrow and add the corrected message it came from, so a
 * future change can be checked against the team's own wording.
 *
 * No database, env or SDK imports.
 */
import type { AskIntent } from "./cs-ask-catalogue-types.ts";
import { labelFor, type SelectedAsk } from "./cs-ask-policy.ts";
import { isAnswered, type Detection } from "./cs-detect.ts";

type RuleContext = {
  object: string | null;
  action: string | null;
  service: string;
  sources: string;
  detection: Detection;
};

type RuleAsk = { intent: AskIntent; phrase: string };

export type TeamRule = {
  id: string;
  /** The asks for this lead, or null when the rule does not apply. */
  match: (ctx: RuleContext) => RuleAsk[] | null;
  /** The opening has to name this, or the questions would point at nothing. */
  openingMustName?: RegExp;
};

const APPLIANCES = new Set([
  "dryer",
  "washer",
  "microwave",
  "refrigerator",
  "oven_stove",
  "dishwasher",
]);
const isRepair = (action: string | null) => action === null || action === "repair";

/** "{object}" in the customer's own word for it: their rug stays a rug. */
const named = (phrase: string, ctx: RuleContext) =>
  phrase.replace(/\{object\}/g, labelFor(ctx.object, ctx.sources, false));

const HANGING =
  /\b(?:hang|hanging|hung|mount|mounting)\b[^.!?\n]*?\b(picture|painting|artwork|mirror|frame|canvas)(s?)\b/i;

export const TEAM_RULES: TeamRule[] = [
  {
    // "...an ac unit and popcorn ceiling repair service. Could you kindly share
    // a picture of the popcorn ceiling that needs to be repaired and let me
    // know the ceiling height"
    id: "popcorn_ceiling",
    openingMustName: /\bpopcorn ceiling/i,
    match: ({ sources }) =>
      /\bpopcorn ceiling/i.test(sources)
        ? [
            {
              intent: "PHOTO",
              phrase: "share a picture of the popcorn ceiling that needs to be repaired",
            },
            { intent: "SIZE", phrase: "let me know the ceiling height" },
          ]
        : null,
  },
  {
    // "...a handyman service to hang a large picture. Could you kindly share
    // pictures of the area where the picture needs to be hung and let me know
    // the size of the picture"
    id: "hang_picture",
    match: ({ sources }) => {
      const found = HANGING.exec(sources);
      if (!found) return null;
      const noun = found[1].toLowerCase();
      return [
        {
          intent: "PHOTO",
          phrase: `share pictures of the area where the ${noun} needs to be hung`,
        },
        { intent: "SIZE", phrase: `let me know the size of the ${noun}` },
      ];
    },
  },
  {
    // "...a siding repair service. Could you kindly share a picture of the
    // siding area that needs to be repaired and let me know your availability"
    id: "siding_repair",
    openingMustName: /\bsiding\b/i,
    match: ({ sources, action, object }) =>
      !object && /\bsiding\b/i.test(sources) && isRepair(action)
        ? [
            {
              intent: "PHOTO",
              phrase: "share a picture of the siding area that needs to be repaired",
            },
            { intent: "AVAILABILITY", phrase: "let me know your availability" },
          ]
        : null,
  },
  {
    // "...a drywall repair service. Could you kindly share a picture of the
    // drywall that needs to be repaired and the size of the drywall area in sq ft"
    id: "drywall_repair",
    match: ({ object, action }) =>
      object === "drywall" && isRepair(action)
        ? [
            { intent: "PHOTO", phrase: "share a picture of the drywall that needs to be repaired" },
            { intent: "SIZE", phrase: "share the size of the drywall area in sq ft" },
          ]
        : null,
  },
  {
    // "...a dryer repair service. Could you kindly let me know what issue you
    // are facing with the dryer and share the brand name of the dryer"
    // "...a microwave repair service. Could you kindly let me know what issue
    // you are facing with your microwave and share the brand name of the microwave"
    id: "appliance_repair",
    match: (ctx) =>
      ctx.object && APPLIANCES.has(ctx.object) && isRepair(ctx.action)
        ? [
            {
              intent: "PROBLEM",
              phrase: named("let me know what issue you are facing with your {object}", ctx),
            },
            { intent: "BRAND/MODEL", phrase: named("share the brand name of the {object}", ctx) },
          ]
        : null,
  },
  {
    // "...an appliance repair service. Could you kindly let me know which
    // appliance you want to repair and share your complete address"
    id: "appliance_unknown",
    match: ({ object, detection, service, sources, action }) =>
      !object &&
      !detection.objects.some((o) => APPLIANCES.has(o)) &&
      isRepair(action) &&
      /\bappli(?:ance|ence)s?\b/i.test(`${service} ${sources}`)
        ? [
            { intent: "SCOPE", phrase: "let me know which appliance you want to repair" },
            { intent: "ADDRESS", phrase: "share your complete address" },
          ]
        : null,
  },
  {
    // "...a dryer vent cleaning service. Could you kindly let me know your
    // availability and share your complete address"
    id: "dryer_vent_clean",
    match: ({ object, action }) =>
      object === "dryer_vent" && (action === "clean" || action === null)
        ? [
            { intent: "AVAILABILITY", phrase: "let me know your availability" },
            { intent: "ADDRESS", phrase: "share your complete address" },
          ]
        : null,
  },
  {
    // "...a carpet cleaning service. Could you kindly share a picture of the
    // carpet area and let me know the size" (rugs the same)
    id: "carpet_clean",
    match: (ctx) =>
      ctx.object === "carpet" && (ctx.action === "clean" || ctx.action === null)
        ? [
            { intent: "PHOTO", phrase: named("share a picture of the {object} area", ctx) },
            { intent: "SIZE", phrase: "let me know the size" },
          ]
        : null,
  },
  {
    // "...a window cleaning service. Could you kindly let me know how many
    // windows need to be cleaned and share a picture of the windows"
    id: "window_clean",
    match: ({ object, action }) =>
      object === "window" && action === "clean"
        ? [
            { intent: "QUANTITY", phrase: "let me know how many windows need to be cleaned" },
            { intent: "PHOTO", phrase: "share pictures of the windows" },
          ]
        : null,
  },
  {
    // "...an electrician to replace a ceiling fan with a new fixture. Could you
    // kindly let me know if you already have the replacement fan and share a
    // picture of the area where the fan needs to be installed"
    id: "ceiling_fan_install",
    match: ({ object, action }) =>
      object === "ceiling_fan" && (action === "install" || action === "replace")
        ? [
            { intent: "OWNERSHIP", phrase: "let me know if you already have the replacement fan" },
            {
              intent: "PHOTO",
              phrase: "share a picture of the area where the fan needs to be installed",
            },
          ]
        : null,
  },
  {
    // "...a holiday light installation service. Could you kindly share a picture
    // of where you want to install the Christmas lights and let me know if you
    // already have the lights" (permanent and Govee lights the same)
    id: "lights_install",
    match: ({ object, action }) =>
      (object === "christmas_lights" || (object === "light_fixture" && action === "install")) &&
      (action === "install" || action === null)
        ? [
            { intent: "PHOTO", phrase: "share a picture of where you want to install the lights" },
            { intent: "OWNERSHIP", phrase: "let me know if you already have the lights" },
          ]
        : null,
  },
  {
    // "...a garage door repair service. Could you kindly let me know what issue
    // you are facing with your garage door and share your complete address"
    id: "garage_door_repair",
    match: ({ object, action }) =>
      object === "garage_door" && isRepair(action)
        ? [
            {
              intent: "PROBLEM",
              phrase: "let me know what issue you are facing with your garage door",
            },
            { intent: "ADDRESS", phrase: "share your complete address" },
          ]
        : null,
  },
  {
    // "...a moving service. Could you kindly share pictures of the items that
    // need to be moved and the complete pickup and drop off addresses"
    id: "moving",
    match: ({ object, action, service, sources, detection }) =>
      object === "furniture_move" ||
      action === "move" ||
      /\b(?:moving|movers?|transport\w*)\b/i.test(`${service} ${sources}`)
        ? [
            { intent: "PHOTO", phrase: "share pictures of the items that need to be moved" },
            detection.sameSite
              ? { intent: "ADDRESS", phrase: "share your complete address" }
              : { intent: "ADDRESS", phrase: "share the complete pickup and drop off addresses" },
          ]
        : null,
  },
  {
    // "...a gutter cleaning service for a double story house. Could you kindly
    // share the size of the house and your complete address"
    id: "gutter_clean",
    match: ({ object, action }) =>
      object === "gutter" && action === "clean"
        ? [
            { intent: "SIZE", phrase: "share the size of the house" },
            { intent: "ADDRESS", phrase: "share your complete address" },
          ]
        : null,
  },
];

/** Asks that only ever close a message. */
const CLOSERS = new Set<AskIntent>(["ADDRESS", "AVAILABILITY"]);

/**
 * The team's pair for this lead, or null to keep the catalogue's choice.
 *
 * `fallback` is the catalogue's remaining asks for the lead (already free of
 * answered facts), used to fill a slot whose rule ask the customer answered.
 */
export function teamCorrection(
  detection: Detection,
  service: string | null | undefined,
  targetObject: string | null,
  sources: string,
  serviceContext: string,
  fallback: SelectedAsk[],
): { id: string; asks: SelectedAsk[]; openingMustName?: RegExp } | null {
  const ctx: RuleContext = {
    object: targetObject,
    action: detection.action,
    service: service ?? "",
    sources,
    detection,
  };
  for (const rule of TEAM_RULES) {
    const asks = rule.match(ctx);
    if (!asks) continue;
    if (rule.openingMustName && !rule.openingMustName.test(serviceContext)) continue;
    const kept: SelectedAsk[] = asks
      .filter((ask) => !isAnswered(ask.intent, detection, targetObject, sources))
      .map((ask) => ({ intent: ask.intent, object: targetObject, fragment: ask.phrase }));
    if (!kept.length) continue;
    if (kept.length < 2) {
      const extra = fallback.find(
        (ask) =>
          ask.intent !== kept[0].intent &&
          !(
            [ask.intent, kept[0].intent].includes("SCOPE") &&
            [ask.intent, kept[0].intent].includes("PROBLEM")
          ),
      );
      if (extra) kept.push(extra);
    }
    if (kept.length === 2 && CLOSERS.has(kept[0].intent) && !CLOSERS.has(kept[1].intent))
      kept.reverse();
    return { id: rule.id, asks: kept, openingMustName: rule.openingMustName };
  }
  return null;
}
