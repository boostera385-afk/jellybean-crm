/** Pure helpers shared by the worker and its regression tests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) await run(items[index++]);
    }),
  );
}

export function sendOutcome(status: number | null): "sent" | "retry" | "failed" | "uncertain" {
  if (status !== null && status >= 200 && status < 300) return "sent";
  if (status === 429 || status === 420) return "retry";
  // A network/5xx failure can occur AFTER the external message was accepted.
  if (status === null || status >= 500 || status === 408) return "uncertain";
  return "failed";
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function eventFingerprint(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(body)),
  );
  return `v2_${Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("")}`;
}
