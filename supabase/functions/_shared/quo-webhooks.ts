const QUO_WEBHOOKS_URL = "https://api.quo.com/webhooks";
const QUO_API_VERSION = "2026-03-30";

type Fetcher = typeof fetch;

type QuoWebhook = {
  id: string;
  url: string;
  events: string[];
};

export type QuoCallWebhookResult =
  | {
      created: true;
      webhookId: string;
      signingKey: string;
      events: string[];
    }
  | {
      created: false;
      webhookId: string;
      signingKey: null;
      events: string[];
    };

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: apiKey,
    "Quo-Api-Version": QUO_API_VERSION,
    "Content-Type": "application/json",
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new Error("invalid_quo_webhook_response");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid_quo_webhook_response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_quo_webhook_response");
  return value as Record<string, unknown>;
}

function parseWebhook(value: unknown): QuoWebhook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.url !== "string" || !Array.isArray(row.events))
    return null;
  const events = row.events.filter((event): event is string => typeof event === "string");
  if (events.length !== row.events.length) return null;
  return { id: row.id, url: row.url, events };
}

/**
 * Ensures Quo sends completed-call activity to JellyBean. The API key and the
 * returned signing key stay server-side; callers receive only the webhook id
 * and event names.
 */
export async function ensureQuoCallWebhook(options: {
  apiKey: string;
  webhookUrl: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
}): Promise<QuoCallWebhookResult> {
  const fetcher = options.fetcher ?? fetch;
  const listResponse = await fetcher(QUO_WEBHOOKS_URL, {
    method: "GET",
    headers: headers(options.apiKey),
    signal: options.signal,
  });
  if (!listResponse.ok)
    throw new Error(listResponse.status === 429 ? "quo_rate_limited" : "quo_webhook_api_error");
  const list = await readJson(listResponse);
  if (!Array.isArray(list.data)) throw new Error("invalid_quo_webhook_response");
  const webhooks = list.data.map(parseWebhook).filter((row): row is QuoWebhook => row !== null);
  if (webhooks.length !== list.data.length) throw new Error("invalid_quo_webhook_response");

  const existing = webhooks.find(
    (webhook) => webhook.url === options.webhookUrl && webhook.events.includes("call.completed"),
  );
  if (existing)
    return {
      created: false,
      webhookId: existing.id,
      signingKey: null,
      events: existing.events,
    };

  const createResponse = await fetcher(QUO_WEBHOOKS_URL, {
    method: "POST",
    headers: headers(options.apiKey),
    signal: options.signal,
    body: JSON.stringify({
      url: options.webhookUrl,
      events: ["call.completed"],
      resourceIds: ["*"],
      label: "JellyBean completed calls",
    }),
  });
  if (!createResponse.ok)
    throw new Error(createResponse.status === 429 ? "quo_rate_limited" : "quo_webhook_api_error");
  const created = await readJson(createResponse);
  const data = created.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("invalid_quo_webhook_response");
  const row = data as Record<string, unknown>;
  const webhook = parseWebhook(row);
  if (!webhook || typeof row.key !== "string" || !row.key.startsWith("whsec_"))
    throw new Error("invalid_quo_webhook_response");
  return {
    created: true,
    webhookId: webhook.id,
    signingKey: row.key,
    events: webhook.events,
  };
}
