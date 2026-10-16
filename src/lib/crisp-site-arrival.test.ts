import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  parseSiteArrival,
  verifySiteArrival,
} from "../../supabase/functions/_shared/crisp-site-arrival";

const website = "87065a95-c96e-4f0b-867d-a4bbb47e08ec";
const session = "session_11111111-1111-4111-8111-111111111111";
const key = "a".repeat(64);
const body = JSON.stringify({ website_id: website, session_id: session, request_id: website });
const script = readFileSync("integrations/wordpress/jellybean-presence/assets/presence.js", "utf8");

describe("signed WordPress arrivals", () => {
  it("accepts identifiers only; rejects malformed/oversized requests", () => {
    expect(parseSiteArrival(body)?.session_id).toBe(session);
    expect(
      parseSiteArrival(
        JSON.stringify({ website_id: [website], session_id: session, request_id: website }),
      ),
    ).toBeNull();
    for (const value of [
      "null",
      "[]",
      "{}",
      "not json",
      body.replace("session_", "wrong_"),
      " ".repeat(2049),
    ]) {
      expect(parseSiteArrival(value)).toBeNull();
    }
  });
  it("matches PHP hash_hmac's raw-body format, rejects forgery, tampering and old timestamps", async () => {
    const now = 1792142556301;
    const timestamp = String(now);
    const signature = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
    expect(await verifySiteArrival(body, timestamp, signature, key, now)).toBe(true);
    expect(await verifySiteArrival(body + " ", timestamp, signature, key, now)).toBe(false);
    expect(await verifySiteArrival(body, timestamp, "0".repeat(64), key, now)).toBe(false);
    expect(await verifySiteArrival(body, timestamp, signature, key, now + 60001)).toBe(false);
    expect(await verifySiteArrival(body, timestamp, signature, key, now - 60001)).toBe(false);
    expect(await verifySiteArrival(body, null, signature, key, now)).toBe(false);
  });
});

function browser(
  options: {
    wrongSite?: boolean;
    storageError?: boolean;
    ready?: boolean;
    hidden?: boolean;
    status?: number;
  } = {},
) {
  const callbacks: Record<string, (...args: string[]) => void> = {};
  const storage = new Map<string, string>();
  const fetch = vi.fn(async () => ({
    ok: !options.status || options.status < 300,
    status: options.status ?? 202,
  }));
  const queue = {
    push: vi.fn((args: [string, string, (...args: string[]) => void]) => {
      callbacks[args[1]] = args[2];
    }),
    ...(options.ready === false ? {} : { get: () => session }),
  };
  const intervals: (() => void)[] = [];
  const window = {
    JellyBeanPresence: {
      websiteId: website,
      endpoint: "https://example.com/wp-json/jellybean/v1/arrival",
    },
    CRISP_WEBSITE_ID: options.wrongSite ? "other-site" : website,
    $crisp: queue,
    crypto: { randomUUID: () => website },
    addEventListener: vi.fn(),
  };
  const context = {
    window,
    crypto: window.crypto,
    location: { href: "https://example.com/", origin: "https://example.com" },
    document: { visibilityState: options.hidden ? "hidden" : "visible", addEventListener: vi.fn() },
    sessionStorage: {
      getItem: (k: string) => {
        if (options.storageError) throw new Error();
        return storage.get(k);
      },
      setItem: (k: string, v: string) => {
        if (options.storageError) throw new Error();
        storage.set(k, v);
      },
    },
    URL,
    AbortController,
    fetch,
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return 1;
    },
    clearInterval: vi.fn(),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    Date,
  };
  runInNewContext(script, context);
  return { callbacks, fetch, window, context, intervals };
}

describe("WordPress visitor script", () => {
  it("signals an already-loaded session once and never loads another widget", async () => {
    const b = browser();
    await vi.waitFor(() => expect(b.fetch).toHaveBeenCalledTimes(1));
    b.intervals[0]();
    b.callbacks["session:loaded"](session);
    expect(b.fetch).toHaveBeenCalledTimes(1);
    const call = b.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ session_id: session, request_id: website });
    expect(call[1].credentials).toBe("omit");
    expect(script).not.toContain("client.crisp.chat");
    expect(script).not.toContain(key);
  });
  it("waits for Crisp and survives queue replacement / blocked storage", async () => {
    const b = browser({ ready: false, storageError: true });
    expect(b.fetch).not.toHaveBeenCalled();
    b.callbacks["session:loaded"](session);
    await vi.waitFor(() => expect(b.fetch).toHaveBeenCalledTimes(1));
    b.intervals[0]();
    b.callbacks["session:loaded"](session);
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });
  it("ignores hidden pages and the wrong Crisp website", () => {
    expect(browser({ wrongSite: true }).fetch).not.toHaveBeenCalled();
    expect(browser({ hidden: true }).fetch).not.toHaveBeenCalled();
  });
  it("does not flood on a permanent error or duplicate script execution", async () => {
    const b = browser({ status: 429 });
    await vi.waitFor(() => expect(b.fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    b.intervals[0]();
    b.callbacks["session:loaded"](session);
    runInNewContext(script, b.context);
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });
  it("backs off and stops after three failed attempts despite readiness polling", async () => {
    let now = 1792142556301;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const b = browser({ status: 503 });
      await new Promise((resolve) => setImmediate(resolve));
      b.intervals[0]();
      expect(b.fetch).toHaveBeenCalledTimes(1);
      now += 2000;
      b.intervals[0]();
      await new Promise((resolve) => setImmediate(resolve));
      expect(b.fetch).toHaveBeenCalledTimes(2);
      now += 4000;
      b.intervals[0]();
      await new Promise((resolve) => setImmediate(resolve));
      now += 60000;
      b.intervals[0]();
      expect(b.fetch).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });
});
