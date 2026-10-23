/**
 * The Quo inboxes a lead can be texted from, as picked on the lead card.
 *
 * A lead stores only the name (number_name); the number is here so the card
 * can show it, and so a lead can be matched to its Quo inbox by number, which
 * survives Quo renaming an inbox ("Dallas Garage Door (HOLD OUTBOUND)"). The
 * names are the saved values: change one and every lead saved with the old
 * name stops matching it.
 *
 * Numbers were read from screenshots of the Quo inbox list on 2026-10-23. A
 * null number is an inbox no longer in use: it stays selectable for the leads
 * already saved with it, but is never matched to a Quo inbox.
 */
export const NUMBER_NAMES: ReadonlyArray<{ name: string; phone: string | null }> = [
  { name: "Appliance Repair Nationwide MIS", phone: null },
  { name: "Atlanta Georgia Appliance Repair / GD", phone: "+14708232133" },
  { name: "Atlanta Georgia Handyman", phone: "+14709448210" },
  { name: "Austin Handyman N/FB", phone: "+17374027035" },
  { name: "Chicago Facebook", phone: "+18723287251" },
  { name: "Chicago Handyman", phone: "+18722787204" },
  { name: "Dallas Garage Door", phone: "+14697188444" },
  { name: "Exterior Painting Nationwide / TV Mounting", phone: "+18329816614" },
  { name: "Garage Door NATIONWIDE MIS", phone: "+13462263895" },
  { name: "Houston Facebook ND Garage Door OP1", phone: null },
  { name: "Houston Handyman", phone: "+18322097989" },
  { name: "Houston Handyman OP1", phone: "+12819426479" },
  { name: "Indianapolis Handyman", phone: "+14632098542" },
  { name: "JOC HOT TUB", phone: null },
  { name: "Junk Removal Nationwide MIS", phone: "+17372775713" },
  { name: "Los Angeles - Handyman", phone: "+12134718651" },
  { name: "Los Angeles Appliance OP1", phone: null },
  { name: "Los Angeles Facebook OP1", phone: "+18188149252" },
  { name: "LOS ANGELES GARAGE DOOR / CLEANING / PLUMBING", phone: "+12132779445" },
  { name: "Los Angeles Handyman FB", phone: "+12133192404" },
  { name: "Max Mad", phone: null },
  { name: "Miami Appliance Repair", phone: "+19542396751" },
  { name: "Miami FB/ND Garage Door OP1", phone: "+17866736371" },
  { name: "Miami Handyman", phone: "+15614646940" },
  { name: "Nationwide Christmas Lights", phone: "+14697785063" },
  { name: "Nationwide Drywall Patch Repair", phone: "+13463539245" },
  { name: "Nationwide Plumbing FB / Nationwide Handyman", phone: "+16822049388" },
  { name: "New Jersey Handyman", phone: "+12014489324" },
  { name: "New York Handyman", phone: "+19292983346" },
  { name: "Orange County Appliance Repair", phone: null },
  { name: "Orange County Handyman OP1", phone: "+16575716845" },
  { name: "San Diego - Appliance Repair", phone: null },
  { name: "San Diego - Handyman", phone: "+16193049048" },
  { name: "San Diego Garage Door OP1", phone: "+18582643190" },
  { name: "San Jose Appliance Repair", phone: null },
  { name: "San Jose Handyman", phone: "+16692026712" },
  { name: "Santa Clarita Handyman", phone: null },
  { name: "Sliding Door", phone: "+13463537571" },
];

/** Must equal public.quo_name_key in SQL: case, spacing and punctuation drop out. */
export function quoNameKey(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const lastTen = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);

export function numberNamePhone(name: string | null | undefined): string | null {
  const key = quoNameKey(name);
  return NUMBER_NAMES.find((entry) => quoNameKey(entry.name) === key)?.phone ?? null;
}

/** "+12819426479" -> "(281) 942-6479". */
export function formatInboxPhone(phone: string | null | undefined): string | null {
  const digits = lastTen(phone);
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : null;
}

/** "Houston Handyman OP1 · (281) 942-6479", or just the name when its number
 *  is not known. Display only: the saved value is always the name. */
export function numberNameLabel(name: string | null | undefined): string {
  const phone = formatInboxPhone(numberNamePhone(name));
  return name ? (phone ? `${name} · ${phone}` : name) : "";
}

/**
 * Which Quo inbox each saved number_name means, keyed by quoNameKey.
 *
 * By number only. Quo's inbox names have drifted from the lead-card names
 * ("Dallas Garage Door (HOLD OUTBOUND)"), and a number does not change when a
 * name does. An option with no number is not matched at all: those are inboxes
 * no longer in use. Inboxes in Quo that are not lead-card options are ignored.
 */
export function inboxKeys(
  inboxes: ReadonlyArray<{ id: string; name?: string | null; number?: string | null }>,
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const entry of NUMBER_NAMES) {
    if (!entry.phone) continue;
    const inbox = inboxes.find((candidate) => lastTen(candidate.number) === lastTen(entry.phone));
    if (inbox) keys[quoNameKey(entry.name)] = inbox.id;
  }
  return keys;
}
