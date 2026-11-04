import { describe, expect, it, vi } from "vitest";
import { ensureQuoCallWebhook } from "../../supabase/functions/_shared/quo-webhooks";

const webhookUrl = "https://project.supabase.co/functions/v1/quo-webhook";
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

describe("Quo completed-call webhook", () => {
  it("keeps an existing completed-call subscription without rotating its key", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response({
        data: [
          {
            id: "WHexisting",
            url: webhookUrl,
            events: ["message.received", "call.completed"],
          },
        ],
      }),
    );
    await expect(
      ensureQuoCallWebhook({ apiKey: "server-key", webhookUrl, fetcher }),
    ).resolves.toEqual({
      created: false,
      webhookId: "WHexisting",
      signingKey: null,
      events: ["message.received", "call.completed"],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({
      Authorization: "server-key",
      "Quo-Api-Version": "2026-03-30",
    });
  });

  it("creates a dedicated call subscription and returns its key only to the server", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(
        response(
          {
            data: {
              id: "WHcalls",
              url: webhookUrl,
              events: ["call.completed"],
              key: "whsec_test-only",
            },
          },
          201,
        ),
      );
    const result = await ensureQuoCallWebhook({ apiKey: "server-key", webhookUrl, fetcher });
    expect(result).toEqual({
      created: true,
      webhookId: "WHcalls",
      signingKey: "whsec_test-only",
      events: ["call.completed"],
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      url: webhookUrl,
      events: ["call.completed"],
      resourceIds: ["*"],
      label: "JellyBean completed calls",
    });
  });

  it("fails closed on malformed provider responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ data: [{ id: "WHbad" }] }));
    await expect(
      ensureQuoCallWebhook({ apiKey: "server-key", webhookUrl, fetcher }),
    ).rejects.toThrow("invalid_quo_webhook_response");
  });
});
