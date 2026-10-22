/**
 * Quo webhook authentication (API version 2026-03-30).
 *
 * Every delivery carries three headers: webhook-id, webhook-timestamp (Unix
 * SECONDS) and webhook-signature, a space-separated list of `v1,<base64>`
 * entries -- a list because Quo sends one entry per active signing key while a
 * secret is being rotated, so any one matching entry authenticates the request.
 *
 * The signature is HMAC-SHA256 over the exact bytes `{id}.{timestamp}.{body}`,
 * base64-encoded, keyed by the base64 payload of the `whsec_` secret.
 *
 * Webhooks created on the legacy /v1 endpoints instead send an
 * openphone-signature header, over different content, with a different
 * timestamp unit. The two are NOT interchangeable, so a delivery carrying only
 * the legacy header is rejected rather than guessed at: accepting it would mean
 * accepting a signature this code cannot actually check.
 */

/** Unix seconds a delivery may be off by before it is treated as a replay. */
export const MAX_SKEW_SECONDS = 300;

export type QuoWebhookHeaders = {
  get(name: string): string | null;
};

export type QuoVerifyFailure =
  | "missing_signature_headers"
  | "legacy_signature_scheme"
  | "malformed_timestamp"
  | "timestamp_out_of_range"
  | "malformed_secret"
  | "no_supported_signature"
  | "signature_mismatch";

export type QuoVerifyResult =
  | { ok: true; webhookId: string; timestamp: number }
  | { ok: false; reason: QuoVerifyFailure };

function decodeBase64(value: string) {
  const binary = atob(value);
  // Allocated here rather than via Uint8Array.from so the buffer type is a
  // plain ArrayBuffer; the SubtleCrypto overloads reject ArrayBufferLike.
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const encodeBase64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

/** Length-independent comparison: never leaks where two signatures diverge. */
function constantTimeEqual(a: string, b: string): boolean {
  // Compare over a fixed width so a length difference costs the same as a
  // content difference. The lengths are still folded into the verdict.
  const width = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < width; index++)
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

/**
 * Verify one delivery. `body` must be the raw request text, exactly as
 * received: re-serializing parsed JSON reorders keys and changes whitespace,
 * and the signature is over bytes, so it would never match again.
 */
export async function verifyQuoWebhook(options: {
  headers: QuoWebhookHeaders;
  body: string;
  secret: string;
  now?: number;
}): Promise<QuoVerifyResult> {
  const { headers } = options;
  const webhookId = headers.get("webhook-id");
  const rawTimestamp = headers.get("webhook-timestamp");
  const signatureList = headers.get("webhook-signature");
  if (!webhookId || !rawTimestamp || !signatureList) {
    // Distinguish "not signed" from "signed the old way", because the remedy
    // differs: recreate the webhook on the current API version.
    const legacy = headers.get("openphone-signature");
    return {
      ok: false,
      reason: legacy ? "legacy_signature_scheme" : "missing_signature_headers",
    };
  }
  if (!/^\d{1,12}$/.test(rawTimestamp)) return { ok: false, reason: "malformed_timestamp" };
  const timestamp = Number(rawTimestamp);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS)
    return { ok: false, reason: "timestamp_out_of_range" };

  // The secret is stored exactly as Quo returns it, prefix included.
  const secretPayload = options.secret.startsWith("whsec_")
    ? options.secret.slice("whsec_".length)
    : options.secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secretPayload))
    return { ok: false, reason: "malformed_secret" };
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decodeBase64(secretPayload),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return { ok: false, reason: "malformed_secret" };
  }

  const signed = `${webhookId}.${rawTimestamp}.${options.body}`;
  const expected = encodeBase64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed))),
  );

  // Only v1 entries are HMAC-SHA256 over this content; any other version is a
  // scheme this code has not been written against.
  const offered = signatureList
    .split(" ")
    .filter(Boolean)
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => entry.slice("v1,".length));
  if (!offered.length) return { ok: false, reason: "no_supported_signature" };
  // Compare every entry rather than stopping at the first match, so the work
  // does not depend on which key signed the delivery.
  let matched = false;
  for (const candidate of offered) matched = constantTimeEqual(candidate, expected) || matched;
  return matched ? { ok: true, webhookId, timestamp } : { ok: false, reason: "signature_mismatch" };
}
