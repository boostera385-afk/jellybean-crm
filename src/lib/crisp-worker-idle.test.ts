import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  mapConcurrent,
  sendOutcome,
  timingSafeEqual,
} from "../../supabase/functions/_shared/crisp-policy";
import { workspaceHeaders } from "../../supabase/functions/_shared/crisp-worker-credentials";

// Execute the real handler with injected platform boundaries, without starting
// a Deno server or making network requests.
const source = readFileSync(
  new URL("../../supabase/functions/crisp-auto-greet/index.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source.replace(/^import .+;\r?$/gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

async function runWorker(presenceLease: string | null, greetingsOnly = false) {
  let handler!: (request: Request) => Promise<Response>;
  const rpc = vi.fn(async (name: string) => {
    const values: Record<string, unknown> = {
      crisp_process_events: 0,
      crisp_claim_greetings: [],
      crisp_claim_presence: presenceLease,
      crisp_get_workspace_secret: { token_id: "id", token_key: "key" },
      crisp_finish_presence_v3: true,
    };
    if (!(name in values)) throw new Error(`Unexpected RPC ${name}`);
    return { data: values[name], error: null };
  });
  const query = {
    select: () => query,
    eq: () => query,
    order: async () => ({
      data: [
        {
          crisp_website_id: "one",
          credential_secret_id: "secret",
          crisp_cooldown_until: null,
          visitor_count_checked_at: null,
          visitor_synced_at: null,
        },
      ],
      error: null,
    }),
  };
  const readPresence = vi.fn(async () => ({
    rows: [],
    complete: true,
    count: 0,
    active: 0,
    limited: false,
    error: null,
    requests: 1,
    cached: false,
  }));
  new Function(
    "serve",
    "createClient",
    "crispFetch",
    "mapConcurrent",
    "sendOutcome",
    "timingSafeEqual",
    "countCheckDue",
    "readPresence",
    "workspaceHeaders",
    "Deno",
    compiled,
  )(
    (callback: typeof handler) => {
      handler = callback;
    },
    () => ({ rpc, from: () => query }),
    () => {
      throw new Error("Unexpected external request");
    },
    mapConcurrent,
    sendOutcome,
    timingSafeEqual,
    () => true,
    readPresence,
    workspaceHeaders,
    {
      env: {
        get: (name: string) => (name === "SUPABASE_URL" ? "https://example.test" : "worker-key"),
      },
    },
  );
  const response = await handler(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer worker-key" },
      body: JSON.stringify({ greetingsOnly }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", greeted: 0, failedWorkspaces: [] });
  return { rpc, readPresence };
}

describe("idle worker regression", () => {
  it("does not decrypt credentials when no greetings or presence are due", async () => {
    const { rpc, readPresence } = await runWorker(null);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "crisp_process_events",
      "crisp_claim_greetings",
      "crisp_claim_presence",
      "crisp_claim_greetings",
    ]);
    expect(readPresence).not.toHaveBeenCalled();
  });
  it("reads credentials once and finishes a due presence lease", async () => {
    const { rpc, readPresence } = await runWorker("lease");
    expect(rpc.mock.calls.filter(([name]) => name === "crisp_get_workspace_secret")).toHaveLength(
      1,
    );
    expect(readPresence).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.filter(([name]) => name === "crisp_finish_presence_v3")).toHaveLength(1);
  });
  it("keeps greeting-only ticks free of presence calls", async () => {
    const { rpc } = await runWorker(null, true);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "crisp_process_events",
      "crisp_claim_greetings",
    ]);
  });
});
