import { describe, expect, it } from "vitest";

import {
  TEMP_MATCH_WINDOW_MS,
  mergeIncomingMessage,
  type ChatMessageLike,
} from "./crisp-chat-messages";

function message(overrides: Partial<ChatMessageLike> = {}): ChatMessageLike {
  return {
    id: "real-1",
    sender_type: "operator",
    direction: "outgoing",
    content: "Hi how can i help you",
    sent_at: "2026-10-17T10:58:00.000Z",
    crisp_message_id: "42",
    ...overrides,
  };
}

describe("crisp chat transcript merge", () => {
  it("upgrades the optimistic placeholder in place instead of duplicating it", () => {
    const temp = message({
      id: "temp_1000",
      crisp_message_id: "42",
      sent_at: "2026-10-17T10:57:59.900Z",
    });
    const real = message();

    const merged = mergeIncomingMessage([temp], real);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(real);
  });

  it("keeps prior real rows and appends unrelated messages", () => {
    const older = message({ id: "real-0", crisp_message_id: "41" });
    const incoming = message({ id: "real-1", crisp_message_id: "42", content: "Different" });

    const merged = mergeIncomingMessage([older], incoming);

    expect(merged).toEqual([older, incoming]);
  });

  it("ignores a realtime row that is already present by id", () => {
    const existing = message();
    expect(mergeIncomingMessage([existing], { ...existing })).toEqual([existing]);
  });

  it("falls back to sender, content and a two-minute window when fingerprints are missing", () => {
    const temp = message({
      id: "temp_1000",
      crisp_message_id: null,
      sent_at: "2026-10-17T10:58:01.000Z",
    });
    const real = message({ crisp_message_id: null });

    const merged = mergeIncomingMessage([temp], real);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("real-1");
  });

  it("never collapses identical operator texts sent apart more than the window", () => {
    const temp = message({
      id: "temp_1000",
      crisp_message_id: null,
      sent_at: "2026-10-17T10:58:00.000Z",
    });
    const lateReal = message({
      crisp_message_id: null,
      sent_at: new Date(Date.parse(temp.sent_at) + TEMP_MATCH_WINDOW_MS + 1).toISOString(),
    });

    const merged = mergeIncomingMessage([temp], lateReal);

    expect(merged).toHaveLength(2);
  });

  it("does not mix matching rules across senders or directions", () => {
    const tempOperator = message({ id: "temp_1000", crisp_message_id: null });
    const visitorRow = message({
      id: "real-9",
      sender_type: "user",
      direction: "incoming",
      crisp_message_id: null,
    });

    const merged = mergeIncomingMessage([tempOperator], visitorRow);

    expect(merged).toHaveLength(2);
    expect(merged[1].id).toBe("real-9");
  });
});
