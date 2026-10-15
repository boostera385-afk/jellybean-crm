/**
 * Sender names for composed CS messages.
 *
 * Every message used to be signed "Alex": the default Schedule Visit template
 * hardcodes "this is Alex" and the other templates carry no name, so the
 * extractor fell through to a literal default. The name is now taken from this
 * roster instead, and the template's own name is ignored.
 *
 * The first 76 entries are names the team already used across 25,918 delivered
 * messages; the rest are additions in the same register. Names that had gone
 * out but should not be reused were dropped: Elon (reads as a specific public
 * figure), the misspellings Buttler and Nathen, the typos Altas/aJoshua/
 * Jaoshua, Reacher, CJ, Smith and Saim.
 */
export const COMPOSE_SENDER_NAMES: readonly string[] = [
  "Martin", "Steve", "Joseph", "Jacob", "Jack", "Jason",
  "Frank", "Joshua", "David", "Max", "Robert", "Justin",
  "Thomas", "Kevin", "Oliver", "Bruce", "Patrick", "Ronnie",
  "Eric", "Henry", "Jerry", "Albert", "Nash", "William",
  "Leo", "Marcus", "Harry", "Ernesto", "Edward", "Ivan",
  "Lucas", "Alex", "Michael", "Andre", "Aaron", "Adam",
  "Jonathan", "Charles", "Joe", "Mark", "Marc", "Stephen",
  "Peter", "Christos", "Marvin", "Craig", "Jess", "Walter",
  "Jimmy", "Ethan", "Atlas", "Shelby", "Judd", "Colin",
  "Daniel", "Jordan", "Brian", "Wayne", "Clark", "Shaun",
  "Steven", "Murphy", "James", "Mateo", "Carlos", "Neil",
  "Carter", "John", "Ryan", "Nick", "Andrew", "Brooks",
  "Roman", "Pedro", "Sergio", "Ben", "Nathan", "Butler",
  "Anthony", "Benjamin", "Bradley", "Brandon", "Brett", "Bryan",
  "Caleb", "Calvin", "Cameron", "Christian", "Christopher", "Clayton",
  "Cody", "Cole", "Connor", "Corey", "Curtis", "Dale",
  "Damon", "Dean", "Dennis", "Derek", "Desmond", "Devin",
  "Dominic", "Douglas", "Drew", "Duncan", "Dustin", "Dylan",
  "Elliot", "Emmett", "Erik", "Evan", "Felix", "Fernando",
  "Finn", "Fletcher", "Forrest", "Francis", "Franklin", "Gabriel",
  "Garrett", "Gavin", "George", "Gerald", "Gilbert", "Glenn",
  "Gordon", "Grant", "Grayson", "Gregory", "Griffin", "Hank",
  "Harold", "Harrison", "Hector", "Howard", "Hugh", "Hunter",
  "Ian", "Isaac", "Isaiah", "Jared", "Jay", "Jeffrey",
  "Jeremy", "Jesse", "Joel", "Johnny", "Jonah", "Josiah",
  "Julian", "Keith", "Kenneth", "Kyle", "Lance", "Landon",
  "Lawrence", "Lee", "Leon", "Leonard", "Levi", "Lincoln",
  "Logan", "Louis", "Luke", "Malcolm", "Manuel", "Marco",
  "Mario", "Marshall", "Mason", "Matthew", "Maurice", "Maxwell",
  "Melvin", "Micah", "Miguel", "Miles", "Mitchell", "Morgan",
  "Nathaniel", "Nelson", "Noah", "Norman", "Oscar", "Owen",
  "Parker", "Paul", "Perry", "Philip", "Preston", "Quentin",
  "Rafael", "Ralph", "Ramon", "Randall", "Raymond", "Reed",
  "Reginald", "Rex",
] as const;

/** How many consecutive messages share one name before it switches. */
export const LEADS_PER_SENDER = 10;

/**
 * Pick the sender for a given counter tick.
 *
 * Ten consecutive ticks return the same name, then it advances; after the whole
 * roster is used it wraps. Negative or non-finite ticks fall back to the first
 * name rather than producing undefined.
 */
export function senderForTick(tick: number): string {
  const total = COMPOSE_SENDER_NAMES.length;
  if (!Number.isFinite(tick) || tick < 0) return COMPOSE_SENDER_NAMES[0]!;
  const slot = Math.floor(tick / LEADS_PER_SENDER) % total;
  return COMPOSE_SENDER_NAMES[slot]!;
}

/**
 * Fallback tick when the shared counter is unreachable.
 *
 * Switches on a time window instead, so a database hiccup degrades to a name
 * that still changes rather than pinning every message to one again.
 */
export function fallbackTick(now: number = Date.now()): number {
  return Math.floor(now / 60_000) * LEADS_PER_SENDER;
}
