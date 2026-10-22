import { describe, expect, it } from "vitest";
import {
  MAX_SKEW_SECONDS,
  verifyQuoWebhook,
} from "../../supabase/functions/_shared/quo-webhook-verify";

const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGVzdGluZy1vbmx5";
const BODY = JSON.stringify({ type: "message.delivered", data: { object: { id: "ACtest" } } });
const ID = "msg_2abcdefghijklmnop";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const TS = String(Math.floor(NOW / 1000));

const headers = (entries: Record<string, string | undefined>) => ({
  get: (name: string) => entries[name.toLowerCase()] ?? null,
});

/** Sign exactly as Quo does, so a passing test proves interoperability. */
async function sign(body: string, id = ID, timestamp = TS, secret = SECRET): Promise<string> {
  const payload = secret.replace(/^whsec_/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return btoa(Array.from(new Uint8Array(mac), (b) => String.fromCharCode(b)).join(""));
}

const signed = async (overrides: Record<string, string | undefined> = {}, body = BODY) =>
  verifyQuoWebhook({
    headers: headers({
      "webhook-id": ID,
      "webhook-timestamp": TS,
      "webhook-signature": `v1,${await sign(body)}`,
      ...overrides,
    }),
    body,
    secret: SECRET,
    now: NOW,
  });

describe("Quo webhook signature verification", () => {
  it("accepts a delivery signed the way Quo signs it", async () => {
    expect(await signed()).toEqual({ ok: true, webhookId: ID, timestamp: Number(TS) });
  });

  it("accepts a delivery during key rotation, when several signatures are offered", async () => {
    const result = await signed({
      "webhook-signature": `v1,${btoa("an-older-key")} v1,${await sign(BODY)}`,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a body altered in transit", async () => {
    const tampered = JSON.stringify({
      type: "message.received",
      data: { object: { id: "ACevil" } },
    });
    const result = await verifyQuoWebhook({
      headers: headers({
        "webhook-id": ID,
        "webhook-timestamp": TS,
        // Signature of the original body, presented with a different one.
        "webhook-signature": `v1,${await sign(BODY)}`,
      }),
      body: tampered,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it.each([
    ["the id is swapped", { "webhook-id": "msg_different" }],
    ["the timestamp is swapped", { "webhook-timestamp": String(Number(TS) - 60) }],
  ])("rejects a replayed signature when %s", async (_name, overrides) => {
    // id and timestamp are inside the signed content, so neither can be moved
    // onto another delivery.
    expect((await signed(overrides)).ok).toBe(false);
  });

  it("rejects a signature made with a different secret", async () => {
    const result = await verifyQuoWebhook({
      headers: headers({
        "webhook-id": ID,
        "webhook-timestamp": TS,
        "webhook-signature": `v1,${await sign(BODY, ID, TS, "whsec_b3RoZXItc2VjcmV0LWVudGlyZWx5")}`,
      }),
      body: BODY,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a stale delivery, and accepts one just inside the window", async () => {
    const stale = Math.floor(NOW / 1000) - MAX_SKEW_SECONDS - 1;
    expect(
      await verifyQuoWebhook({
        headers: headers({
          "webhook-id": ID,
          "webhook-timestamp": String(stale),
          "webhook-signature": `v1,${await sign(BODY, ID, String(stale))}`,
        }),
        body: BODY,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "timestamp_out_of_range" });

    const fresh = Math.floor(NOW / 1000) - MAX_SKEW_SECONDS;
    expect(
      (
        await verifyQuoWebhook({
          headers: headers({
            "webhook-id": ID,
            "webhook-timestamp": String(fresh),
            "webhook-signature": `v1,${await sign(BODY, ID, String(fresh))}`,
          }),
          body: BODY,
          secret: SECRET,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("names the legacy scheme instead of silently failing, since the fix differs", async () => {
    // A webhook created on the legacy /v1 endpoints signs different content
    // with a different timestamp unit. Telling these apart is the difference
    // between "recreate the webhook" and "check the secret".
    expect(
      await verifyQuoWebhook({
        headers: headers({ "openphone-signature": "hmac;1;1700000000;c2ln" }),
        body: BODY,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "legacy_signature_scheme" });
  });

  it("rejects an unsigned delivery and a scheme version it cannot check", async () => {
    expect((await verifyQuoWebhook({ headers: headers({}), body: BODY, secret: SECRET })).ok).toBe(
      false,
    );
    expect(await signed({ "webhook-signature": "v2,c2lnbmF0dXJl" })).toEqual({
      ok: false,
      reason: "no_supported_signature",
    });
    expect(await signed({ "webhook-timestamp": "not-a-number" })).toEqual({
      ok: false,
      reason: "malformed_timestamp",
    });
  });

  it("refuses a secret that is not usable as a key rather than treating it as empty", async () => {
    const result = await verifyQuoWebhook({
      headers: headers({
        "webhook-id": ID,
        "webhook-timestamp": TS,
        "webhook-signature": `v1,${await sign(BODY)}`,
      }),
      body: BODY,
      secret: "whsec_not valid base64!",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_secret" });
  });
});
