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
 *
 * Two families are read: message events (the AI comparison reacts to these) and
 * call events (counted towards the reach-out tally only). For both we need the
 * customer's number, whether it was inbound (the customer reaching us) or
 * outbound (us reaching the customer), and which family it is.
 */

/** The three message events this integration acts on. */
export const QUO_MESSAGE_EVENTS = [
  "message.received",
  "message.delivered",
  "message.undelivered",
] as const;

/** Completed calls are the only call event counted: one completed call is one
 *  reach-out, and keying on it avoids double-counting ringing/answered events
 *  for the same call. */
export const QUO_CALL_EVENTS = ["call.completed"] as const;

export type QuoMessageEventType = (typeof QUO_MESSAGE_EVENTS)[number];
export type QuoCallEventType = (typeof QUO_CALL_EVENTS)[number];

export type QuoEventReadResult =
  | {
      kind: "event";
      category: "message" | "call";
      type: QuoMessageEventType | QuoCallEventType;
      /** inbound = the customer contacted us; outbound = we contacted them. */
      direction: "inbound" | "outbound";
      participant: string;
    }
  /**
   * Verified, but nothing to do with it. The caller answers 2xx so Quo stops
   * redelivering: retrying cannot turn an unhandled event into a handled one.
   */
  | { kind: "ignored"; reason: string };

const isMessageEvent = (value: unknown): value is QuoMessageEventType =>
  QUO_MESSAGE_EVENTS.includes(value as QuoMessageEventType);
const isCallEvent = (value: unknown): value is QuoCallEventType =>
  QUO_CALL_EVENTS.includes(value as QuoCallEventType);

/**
 * Pull the event family, direction and the customer's number out of a raw
 * delivery body.
 *
 * `direction` is authoritative when present, because it describes the message
 * rather than the notification: on an inbound item the customer is `from`, and
 * on an outbound one they are the single entry in `to`. For messages the event
 * type is a fallback when direction is absent; a call carries no such name
 * fallback (one event name covers both directions), so a call with no direction
 * is dropped rather than miscounted.
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
  const category = isMessageEvent(envelope.type)
    ? "message"
    : isCallEvent(envelope.type)
      ? "call"
      : null;
  if (!category)
    return {
      kind: "ignored",
      reason: typeof envelope.type === "string" ? "unhandled_event_type" : "missing_event_type",
    };
  const eventType = envelope.type as QuoMessageEventType | QuoCallEventType;
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
  // Messages may fall back to the event name; a call must state its direction.
  const inbound =
    direction === "incoming" ||
    (direction === undefined && category === "message" && eventType === "message.received");
  if (direction === undefined && category === "call")
    return { kind: "ignored", reason: "missing_direction" };

  const event = (participant: string): QuoEventReadResult => ({
    kind: "event",
    category,
    type: eventType,
    direction: inbound ? "inbound" : "outbound",
    participant,
  });

  if (inbound) {
    if (typeof from !== "string" || !from.trim())
      return { kind: "ignored", reason: "missing_sender" };
    return event(from);
  }
  // Outbound. Messages carry `to` as an array of recipients; a call carries a
  // single `to` string. Accept either, so an outbound call we place is counted
  // and not dropped as "missing_recipient". Several recipients cannot be
  // attributed to one lead, and the worker would refuse the thread as ambiguous
  // anyway, so dropping those here saves that round.
  const recipients = Array.isArray(to) ? to : typeof to === "string" && to.trim() ? [to] : null;
  if (!recipients || recipients.length === 0)
    return { kind: "ignored", reason: "missing_recipient" };
  if (recipients.length !== 1) return { kind: "ignored", reason: "group_conversation" };
  const recipient = recipients[0];
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
  return event(number);
}
