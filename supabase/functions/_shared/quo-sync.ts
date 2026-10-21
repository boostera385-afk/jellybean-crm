import { fetchQuoHistoryPage, normalizeQuoPhone, type QuoMessage } from "./quo-ai-status.ts";

export type QuoCheckpoint = {
  version: 1;
  snapshot: string;
  phones: string[];
  phoneIndex: number;
  inboxIndex: number;
  pageToken: string | null;
  seenTokens: string[];
  messages: QuoMessage[];
};
export function createQuoCheckpoint(
  snapshot: string,
  numbers: Array<string | null | undefined>,
): QuoCheckpoint {
  const phones = [...new Set(numbers.filter(Boolean).map(normalizeQuoPhone))];
  if (
    !Number.isFinite(Date.parse(snapshot)) ||
    phones.includes(null) ||
    phones.length < 1 ||
    phones.length > 3
  )
    throw new Error("invalid_or_excess_customer_numbers");
  return {
    version: 1,
    snapshot,
    phones: phones as string[],
    phoneIndex: 0,
    inboxIndex: 0,
    pageToken: null,
    seenTokens: [],
    messages: [],
  };
}

export async function advanceQuoCheckpoint(
  checkpoint: QuoCheckpoint,
  options: {
    apiKey: string;
    inboxIds: string[];
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    reserveRequest?: () => Promise<void>;
    maxRequests?: number;
  },
): Promise<{ checkpoint: QuoCheckpoint; complete: boolean; done: number; total: number }> {
  const c = structuredClone(checkpoint);
  const total = c.phones.length * options.inboxIds.length;
  if (
    !options.inboxIds.length ||
    options.inboxIds.length > 100 ||
    c.version !== 1 ||
    c.phoneIndex < 0 ||
    c.phoneIndex > c.phones.length ||
    c.inboxIndex < 0 ||
    c.inboxIndex >= options.inboxIds.length
  )
    throw new Error("invalid_checkpoint");
  const messages = new Map(c.messages.map((m) => [`${m.phoneNumberId}:${m.id}`, m]));
  const maxRequests = Math.min(16, Math.max(1, options.maxRequests ?? 16));
  for (let request = 0; request < maxRequests && c.phoneIndex < c.phones.length; request++) {
    const page = await fetchQuoHistoryPage({
      apiKey: options.apiKey,
      phoneNumberId: options.inboxIds[c.inboxIndex],
      participant: c.phones[c.phoneIndex],
      snapshot: c.snapshot,
      pageToken: c.pageToken,
      fetcher: options.fetcher,
      reserveRequest: options.reserveRequest,
      signal: options.signal,
    });
    for (const m of page.messages) {
      const key = `${m.phoneNumberId}:${m.id}`;
      const previous = messages.get(key);
      if (!previous || Date.parse(previous.updatedAt) <= Date.parse(m.updatedAt))
        messages.set(key, m);
    }
    c.messages = [...messages.values()];
    // Refuse oversized context, never truncate away messages to fit a model.
    if (JSON.stringify(c).length > 240_000) throw new Error("history_too_large");
    c.pageToken = page.nextPageToken;
    if (c.pageToken) {
      if (c.seenTokens.includes(c.pageToken) || c.seenTokens.length >= 20)
        throw new Error("incomplete_history");
      c.seenTokens.push(c.pageToken);
    } else {
      c.seenTokens = [];
      c.inboxIndex++;
      if (c.inboxIndex === options.inboxIds.length) {
        c.inboxIndex = 0;
        c.phoneIndex++;
      }
    }
  }
  c.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return {
    checkpoint: c,
    complete: c.phoneIndex === c.phones.length,
    done: c.phoneIndex * options.inboxIds.length + c.inboxIndex,
    total,
  };
}

const b64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const unb64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
async function checkpointKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`jellybean-quo-checkpoint-v1:${secret}`),
  );
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptQuoCheckpoint(
  checkpoint: QuoCheckpoint,
  secret: string,
  runId: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(runId) },
    await checkpointKey(secret),
    new TextEncoder().encode(JSON.stringify(checkpoint)),
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}
export async function decryptQuoCheckpoint(
  encrypted: string,
  secret: string,
  runId: string,
): Promise<QuoCheckpoint> {
  const [version, iv, data] = encrypted.split(".");
  if (version !== "v1" || !iv || !data || encrypted.length > 400_000)
    throw new Error("invalid_checkpoint");
  try {
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(runId) },
      await checkpointKey(secret),
      unb64(data),
    );
    const checkpoint = JSON.parse(new TextDecoder().decode(raw));
    if (
      checkpoint.version !== 1 ||
      !Array.isArray(checkpoint.phones) ||
      !Array.isArray(checkpoint.messages)
    )
      throw new Error();
    return checkpoint;
  } catch {
    throw new Error("invalid_checkpoint");
  }
}
