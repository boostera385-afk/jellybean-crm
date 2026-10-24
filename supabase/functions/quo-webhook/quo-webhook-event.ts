/**
 * Reading a verified Quo webhook delivery.
 *
 * Kept apart from the handler so it can be tested: deciding which number in a
 * payload is the CUSTOMER's, as opposed to one of our own inboxes, is the part
 * that fails quietly. Get it backwards and every event resolves to no lead at
 * all, or worse, to whichever lead happens to hold our own inbox number.
 *
 * Everything here runs AFTER the signature check, so the bytes are known to
 * come from Quo -- but "from Quo" is not "in the shape we expect", so each
 * field is still checked rather than assumed.
 */

/** The three message events this integration acts on. */
export const QUO_MESSAGE_EVENTS = [
  "message.received",
  "message.delivered",
  "message.undelivered",
] as const;

export type QuoMessageEventType = (typeof QUO_MESSAGE_EVENTS)[number];

export type QuoEventReadResult =
  | { kind: "message"; type: QuoMessageEventType; participant: string }
  /**
   * Verified, but nothing to do with it. The caller answers 2xx so Quo stops
   * redelivering: retrying cannot turn a call event into a message one.
   */
  | { kind: "ignored"; reason: string };

const isMessageEvent = (value: unknown): value is QuoMessageEventType =>
  QUO_MESSAGE_EVENTS.includes(value as QuoMessageEventType);

/**
 * Pull the event type and the customer's number out of a raw delivery body.
 *
 * `direction` is authoritative when present, because it describes the message
 * rather than the notification: on an inbound message the customer is `from`,
 * and on an outbound one they are the single entry in `to`. The event type is
 * only a fallback for a payload that omits direction.
 */
export function readQuoMessageEvent(raw: string): QuoEventReadResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { kind: "ignored", reason: "unparseable_body" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { kind: "ignored", reason: "unexpected_envelope" };
  const envelope = body as Record<string, unknown>;
  if (!isMessageEvent(envelope.type))
    return {
      kind: "ignored",
      reason: typeof envelope.type === "string" ? "unhandled_event_type" : "missing_event_type",
    };
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { kind: "ignored", reason: "missing_event_data" };
  const payload = data as Record<string, unknown>;
  const currentVersion = "resource" in payload;
  const object = currentVersion ? payload.resource : payload.object;
  if (!object || typeof object !== "object" || Array.isArray(object))
    return { kind: "ignored", reason: "missing_event_object" };
  const message = object as Record<string, unknown>;
  const context = payload.context;
  if (currentVersion && (!context || typeof context !== "object" || Array.isArray(context)))
    return { kind: "ignored", reason: "missing_event_context" };
  const participants = context as Record<string, unknown> | undefined;

  const direction = message.direction;
  const from = currentVersion ? participants?.senderIdentifier : message.from;
  const to = currentVersion ? participants?.recipientIdentifiers : message.to;
  if (direction !== undefined && direction !== "incoming" && direction !== "outgoing")
    return { kind: "ignored", reason: "unexpected_direction" };
  const inbound =
    direction === "incoming" || (direction === undefined && envelope.type === "message.received");

  if (inbound) {
    if (typeof from !== "string" || !from.trim())
      return { kind: "ignored", reason: "missing_sender" };
    return { kind: "message", type: envelope.type, participant: from };
  }
  // Several recipients cannot be attributed to one lead, and the worker would
  // refuse the thread as ambiguous anyway. Dropping it here saves that round.
  if (!Array.isArray(to)) return { kind: "ignored", reason: "missing_recipient" };
  if (to.length !== 1) return { kind: "ignored", reason: "group_conversation" };
  const recipient = to[0];
  // Quo has sent recipients both as bare strings and as objects carrying the
  // number, so accept either rather than silently resolving no lead.
  const number =
    typeof recipient === "string"
      ? recipient
      : !currentVersion && recipient && typeof recipient === "object" && !Array.isArray(recipient)
        ? (recipient as Record<string, unknown>).phoneNumber
        : undefined;
  if (typeof number !== "string" || !number.trim())
    return { kind: "ignored", reason: "missing_recipient" };
  return { kind: "message", type: envelope.type, participant: number };
}
