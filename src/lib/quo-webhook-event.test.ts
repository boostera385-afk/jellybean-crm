import { describe, expect, it } from "vitest";
import { readQuoMessageEvent } from "../../supabase/functions/quo-webhook/quo-webhook-event";

const envelope = (type: string, object: unknown) => JSON.stringify({ type, data: { object } });
const currentEnvelope = (type: string, resource: unknown, context: unknown) =>
  JSON.stringify({ apiVersion: "2026-03-30", type, data: { resource, context } });

describe("reading a Quo webhook delivery", () => {
  it("reads the customer from current API inbound context", () => {
    expect(
      readQuoMessageEvent(
        currentEnvelope(
          "message.received",
          { id: "ACin", direction: "incoming", status: "received" },
          {
            senderIdentifier: "+19105551234",
            recipientIdentifiers: ["+19105559999"],
          },
        ),
      ),
    ).toEqual({
      kind: "event",
      category: "message",
      type: "message.received",
      direction: "inbound",
      participant: "+19105551234",
    });
  });

  it.each(["message.delivered", "message.undelivered"])(
    "reads the customer from current API outbound context on %s",
    (type) => {
      expect(
        readQuoMessageEvent(
          currentEnvelope(
            type,
            { id: "ACout", direction: "outgoing", status: type.slice(8) },
            {
              senderIdentifier: "+19105559999",
              recipientIdentifiers: ["+19105551234"],
            },
          ),
        ),
      ).toEqual({
        kind: "event",
        category: "message",
        type,
        direction: "outbound",
        participant: "+19105551234",
      });
    },
  );

  it("does not attribute a current API group message to one lead", () => {
    expect(
      readQuoMessageEvent(
        currentEnvelope(
          "message.delivered",
          { direction: "outgoing" },
          {
            senderIdentifier: "+19105559999",
            recipientIdentifiers: ["+19105551234", "+19105555678"],
          },
        ),
      ),
    ).toEqual({ kind: "ignored", reason: "group_conversation" });
  });

  it("does not use the old message fields when current API context is missing", () => {
    expect(
      readQuoMessageEvent(
        currentEnvelope("message.received", { direction: "incoming", from: "+19105551234" }, null),
      ),
    ).toEqual({ kind: "ignored", reason: "missing_event_context" });
  });

  it("takes the sender as the customer on an inbound message", () => {
    expect(
      readQuoMessageEvent(
        envelope("message.received", {
          id: "ACin",
          direction: "incoming",
          from: "+19105551234",
          to: ["+19105559999"],
        }),
      ),
    ).toEqual({
      kind: "event",
      category: "message",
      type: "message.received",
      direction: "inbound",
      participant: "+19105551234",
    });
  });

  it.each(["message.delivered", "message.undelivered"])(
    "takes the recipient as the customer on %s",
    (type) => {
      // `from` here is our own inbox. Reading it as the customer would resolve
      // the event to no lead, or to whichever lead holds our own number.
      expect(
        readQuoMessageEvent(
          envelope(type, {
            id: "ACout",
            direction: "outgoing",
            from: "+19105559999",
            to: ["+19105551234"],
          }),
        ),
      ).toEqual({
        kind: "event",
        category: "message",
        type,
        direction: "outbound",
        participant: "+19105551234",
      });
    },
  );

  it("counts an outbound call as a reach-out to the recipient", () => {
    expect(
      readQuoMessageEvent(
        envelope("call.completed", {
          direction: "outgoing",
          from: "+19105559999",
          to: ["+19105551234"],
        }),
      ),
    ).toEqual({
      kind: "event",
      category: "call",
      type: "call.completed",
      direction: "outbound",
      participant: "+19105551234",
    });
  });

  it("counts an outbound call when `to` is a single string, not an array", () => {
    // Quo/OpenPhone call objects send `to` as a bare string (messages use an
    // array). This must still resolve to the customer, not be dropped.
    expect(
      readQuoMessageEvent(
        envelope("call.completed", {
          direction: "outgoing",
          from: "+19105559999",
          to: "+19105551234",
        }),
      ),
    ).toEqual({
      kind: "event",
      category: "call",
      type: "call.completed",
      direction: "outbound",
      participant: "+19105551234",
    });
  });

  it("reads an inbound call as the customer responding", () => {
    expect(
      readQuoMessageEvent(
        currentEnvelope(
          "call.completed",
          { direction: "incoming", status: "completed" },
          { senderIdentifier: "+19105551234", recipientIdentifiers: ["+19105559999"] },
        ),
      ),
    ).toEqual({
      kind: "event",
      category: "call",
      type: "call.completed",
      direction: "inbound",
      participant: "+19105551234",
    });
  });

  it("drops a call with no stated direction rather than miscounting it", () => {
    expect(readQuoMessageEvent(envelope("call.completed", { from: "+19105551234" }))).toEqual({
      kind: "ignored",
      reason: "missing_direction",
    });
  });

  it("trusts direction over the event name when the two could disagree", () => {
    // A delivery receipt for an inbound message is not something Quo sends,
    // but if it ever did, the message's own direction describes the message.
    expect(
      readQuoMessageEvent(
        envelope("message.delivered", {
          direction: "incoming",
          from: "+19105551234",
          to: ["+19105559999"],
        }),
      ),
    ).toMatchObject({ participant: "+19105551234", direction: "inbound" });
  });

  it("falls back to the event name when direction is absent", () => {
    expect(
      readQuoMessageEvent(envelope("message.received", { from: "+19105551234" })),
    ).toMatchObject({ participant: "+19105551234", direction: "inbound" });
    expect(
      readQuoMessageEvent(envelope("message.delivered", { to: ["+19105551234"] })),
    ).toMatchObject({ participant: "+19105551234", direction: "outbound" });
  });

  it("accepts a recipient sent as an object rather than a bare string", () => {
    expect(
      readQuoMessageEvent(
        envelope("message.delivered", {
          direction: "outgoing",
          to: [{ phoneNumber: "+19105551234", status: "delivered" }],
        }),
      ),
    ).toMatchObject({ participant: "+19105551234" });
  });

  it("drops a group thread rather than attributing it to one lead", () => {
    expect(
      readQuoMessageEvent(
        envelope("message.delivered", {
          direction: "outgoing",
          to: ["+19105551234", "+19105555678"],
        }),
      ),
    ).toEqual({ kind: "ignored", reason: "group_conversation" });
  });

  it.each([
    ["a contact event", envelope("contact.updated", { id: "CTx" }), "unhandled_event_type"],
    ["no type at all", JSON.stringify({ data: { object: {} } }), "missing_event_type"],
    ["no data", JSON.stringify({ type: "message.received" }), "missing_event_data"],
    ["no object", JSON.stringify({ type: "message.received", data: {} }), "missing_event_object"],
    ["an array envelope", JSON.stringify([{ type: "message.received" }]), "unexpected_envelope"],
    ["malformed JSON", "{not json", "unparseable_body"],
  ])("ignores %s", (_name, raw, reason) => {
    expect(readQuoMessageEvent(raw)).toEqual({ kind: "ignored", reason });
  });

  it.each([
    [
      "an unknown direction",
      { direction: "sideways", from: "+19105551234" },
      "unexpected_direction",
    ],
    ["an inbound message with no sender", { direction: "incoming", to: ["+1"] }, "missing_sender"],
    [
      "an outbound message with no recipient",
      { direction: "outgoing", from: "+1" },
      "missing_recipient",
    ],
    ["a blank recipient", { direction: "outgoing", to: ["   "] }, "missing_recipient"],
  ])("ignores %s", (_name, object, reason) => {
    expect(readQuoMessageEvent(envelope("message.received", object))).toEqual({
      kind: "ignored",
      reason,
    });
  });
});
