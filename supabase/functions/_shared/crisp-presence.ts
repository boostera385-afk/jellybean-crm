/** Presence reads never infer visitor identity from an unchanged counter. */
export type PresenceVisitor = { session_id: string; [key: string]: unknown };
export type PresenceSnapshot = {
  rows: PresenceVisitor[];
  count: number | null;
  active: number | null;
  limited: boolean | null;
  complete: boolean;
  requests: number;
  error: string | null;
  cached: boolean;
};

export function countCheckDue(lastCheck: string | null, now = Date.now()): boolean {
  const at = lastCheck ? Date.parse(lastCheck) : NaN;
  return !Number.isFinite(at) || now - at >= 45_000;
}

/** Fast passes discover identities; only a validated full pass proves absence. */
export async function readPresence(
  get: (path: string) => Promise<Response>,
  checkCount: boolean,
  targetSessions: string[] = [],
): Promise<PresenceSnapshot> {
  const snapshot: PresenceSnapshot = {
    rows: [],
    count: null,
    active: null,
    limited: null,
    complete: false,
    requests: 0,
    error: null,
    cached: false,
  };
  const seen = new Set<string>();
  let cached = false;
  const request = async (path: string) => {
    snapshot.requests++;
    const response = await get(path);
    if (["HIT", "OFFLINE"].includes(response.headers.get("Bloom-Status") ?? "")) {
      cached = true;
      snapshot.cached = true;
    }
    if (!response.ok)
      throw new Error(
        `Visitor ${path.includes("count") ? "count" : "list"} HTTP ${response.status}`,
      );
    return response;
  };
  try {
    if (checkCount) {
      const response = await request("count");
      const payload = await response.json();
      const counter = payload?.data;
      if (
        payload?.error ||
        !Number.isInteger(counter?.count) ||
        counter.count < 0 ||
        typeof counter.limited !== "boolean"
      )
        throw new Error("Invalid visitor count");
      snapshot.count = counter.count;
      snapshot.active =
        Number.isInteger(counter.active) && counter.active >= 0 ? counter.active : null;
      snapshot.limited = counter.limited;
      if (counter.count === 0 && !cached) {
        snapshot.complete = !counter.limited;
        return snapshot;
      }
    }
    const pageLimit = targetSessions.length ? 3 : 10;
    for (let page = 1; page <= pageLimit; page++) {
      const response = await request(`list/${page}`);
      const payload = await response.json();
      if (payload?.error || !Array.isArray(payload?.data)) throw new Error("Invalid visitor list");
      const pageIds = new Set<string>();
      for (const visitor of payload.data) {
        if (!visitor || typeof visitor.session_id !== "string" || !visitor.session_id.trim())
          throw new Error("Visitor identifier missing");
        if (seen.has(visitor.session_id) || pageIds.has(visitor.session_id))
          throw new Error("Duplicate visitor pagination");
        pageIds.add(visitor.session_id);
      }
      for (const visitor of payload.data) {
        seen.add(visitor.session_id);
        snapshot.rows.push(visitor);
      }
      // 206 is partial even when a cached counter matches this page.
      if (response.status === 206) continue;
      if (
        !checkCount &&
        (!targetSessions.length ||
          payload.data.length === 0 ||
          targetSessions.every((session) => seen.has(session)))
      )
        return snapshot;
      if (!checkCount) continue; // Target not found: bounded paging, never absence proof.
      if (snapshot.rows.length === snapshot.count) {
        snapshot.complete = !snapshot.limited && !cached;
        return snapshot;
      }
      if (payload.data.length === 0 || snapshot.rows.length > (snapshot.count ?? 0))
        throw new Error("Visitor count/list mismatch");
    }
    if (!checkCount && targetSessions.length) return snapshot;
    throw new Error("Visitor pagination limit reached");
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : "Presence refresh failed";
  }
  return snapshot;
}
