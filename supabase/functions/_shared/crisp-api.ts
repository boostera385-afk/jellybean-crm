export type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** Distributed rolling-window accounting. Never retry an external send here. */
export async function crispFetch(
  admin: RpcClient,
  url: string,
  init: RequestInit = {},
  priority: "background" | "interactive" = "background",
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.origin !== "https://api.crisp.chat") throw new Error("Unexpected Crisp API origin");
  const websiteId = parsed.pathname.match(/^\/v1\/website\/([^/]+)/)?.[1];
  if (!websiteId) throw new Error("Crisp workspace required");
  const { data, error } = await admin.rpc("crisp_reserve_request", {
    p_website_id: websiteId,
    p_interactive: priority === "interactive",
  });
  if (error) throw new Error(`Crisp budget unavailable: ${error.message}`);
  if (data !== true) throw new Error("Crisp request budget or cooldown reached");
  const started = performance.now();
  // Do not log credentials, query strings, bodies or visitor identifiers.
  const route = parsed.pathname
    .replace(websiteId, ":website")
    .replace(/session_[^/]+/g, ":session");
  let status: number | null = null;
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(8_000),
    });
    status = response.status;
    if (status === 429 || status === 420) {
      const retry = Number(response.headers.get("Retry-After"));
      const { error: cooldownError } = await admin.rpc("crisp_set_cooldown", {
        p_website_id: websiteId,
        p_seconds: Number.isFinite(retry) && retry > 0 ? Math.min(3600, retry) : 60,
      });
      if (cooldownError) console.error("Crisp cooldown persistence failed", cooldownError.message);
    }
    if (priority === "background" && [401, 403, 404].includes(status)) {
      const { error: cooldownError } = await admin.rpc("crisp_set_cooldown", {
        p_website_id: websiteId,
        p_seconds: 300,
      });
      if (cooldownError)
        console.error("Crisp error backoff persistence failed", cooldownError.message);
    }
    console.info(
      JSON.stringify({
        component: "crisp-api",
        websiteId,
        route,
        status,
        durationMs: Math.round(performance.now() - started),
        bloom: response.headers.get("Bloom-Status"),
      }),
    );
    return response;
  } catch (error) {
    console.error(
      JSON.stringify({
        component: "crisp-api",
        websiteId,
        route,
        status,
        durationMs: Math.round(performance.now() - started),
        result: "request_failed",
      }),
    );
    throw error;
  }
}
