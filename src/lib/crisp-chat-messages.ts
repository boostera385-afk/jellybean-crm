// Merging realtime messages into the open transcript.
//
// An operator send appends an optimistic placeholder row (id starting with
// "temp_") so the reply appears instantly. The real row then arrives through a
// realtime INSERT (and periodic re-fetches). Matching only on the row id —
// the old behaviour — left the placeholder behind because `temp_*` never
// equals the database id, so the same message briefly rendered twice and the
// visitor side showed a single bubble while the transcript showed two.
export const TEMP_MESSAGE_ID_PREFIX = "temp_";

// Fallback match window when Crisp's send response omitted the message
// fingerprint (crisp_message_id) and realtime row has none either. Two
// genuinely identical operator messages typed more than two minutes apart are
// never collapsed by it.
export const TEMP_MATCH_WINDOW_MS = 120_000;

export type ChatMessageLike = {
  id: string;
  sender_type: string;
  direction: string;
  content: string;
  sent_at: string;
  crisp_message_id: string | null;
};

function sentAtTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesTemp(
  temp: ChatMessageLike,
  incoming: ChatMessageLike,
  incomingTime: number | null,
): boolean {
  if (!temp.id.startsWith(TEMP_MESSAGE_ID_PREFIX)) return false;
  if (temp.sender_type !== incoming.sender_type) return false;
  if (temp.direction !== incoming.direction) return false;
  if (temp.content !== incoming.content) return false;

  // The send response's fingerprint is authoritative: same fingerprint means
  // this realtime row IS the acknowledgement of that optimistic send.
  if (temp.crisp_message_id && incoming.crisp_message_id) {
    return temp.crisp_message_id === incoming.crisp_message_id;
  }

  const tempTime = sentAtTime(temp.sent_at);
  if (tempTime === null || incomingTime === null) return false;
  return Math.abs(incomingTime - tempTime) <= TEMP_MATCH_WINDOW_MS;
}

// Returns a new array (never mutates): identical rows are ignored, the first
// matching placeholder in the open conversation is upgraded in place to the
// real database row, and anything else is appended.
export function mergeIncomingMessage<T extends ChatMessageLike>(
  prev: readonly T[],
  incoming: T,
): T[] {
  if (prev.some((m) => m.id === incoming.id)) return [...prev];

  const incomingTime = sentAtTime(incoming.sent_at);
  const index = prev.findIndex((m) => matchesTemp(m, incoming, incomingTime));
  if (index === -1) return [...prev, incoming];

  const next: T[] = [...prev];
  next[index] = incoming;
  return next;
}
