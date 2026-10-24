import { describe, expect, it, vi } from "vitest";
import { workspaceHeaders } from "../../supabase/functions/_shared/crisp-worker-credentials";

describe("worker credential reads", () => {
  it("does not read/decrypt credentials for idle workspaces", () => {
    const rpc = vi.fn();
    workspaceHeaders({ rpc }, "one");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("shares one credential read across greeting and presence tasks", async () => {
    const rpc = vi.fn(async () => ({ data: { token_id: "id", token_key: "key" }, error: null }));
    const headers = workspaceHeaders({ rpc }, "one");
    const results = await Promise.all([headers(), headers(), headers()]);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("crisp_get_workspace_secret", {
      p_secret_id: "one",
    });
    expect(results[0]).toEqual({
      Authorization: `Basic ${btoa("id:key")}`,
      "X-Crisp-Tier": "website",
      "Content-Type": "application/json",
    });
    expect(results[1]).toBe(results[0]);
  });
  it("does not share secrets across invocations or workspaces", async () => {
    const rpc = vi.fn(async () => ({ data: { tokenId: "id", tokenKey: "key" }, error: null }));
    await workspaceHeaders({ rpc }, "one")();
    await workspaceHeaders({ rpc }, "two")();
    await workspaceHeaders({ rpc }, "one")();
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it("fails closed on missing or invalid credentials", async () => {
    for (const data of [null, {}, { token_id: "id" }]) {
      await expect(
        workspaceHeaders({ rpc: async () => ({ data, error: null }) }, "one")(),
      ).rejects.toThrow("Workspace credentials missing");
    }
  });
  it("propagates database failures without a retry loop", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "unavailable" } }));
    const headers = workspaceHeaders({ rpc }, "one");
    await expect(headers()).rejects.toThrow("unavailable");
    await expect(headers()).rejects.toThrow("unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
