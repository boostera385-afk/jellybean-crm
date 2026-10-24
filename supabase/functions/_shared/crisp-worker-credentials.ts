import type { RpcClient } from "./crisp-api.ts";

/** Invocation-local only: no stale secrets across rotations or workspaces. */
export function workspaceHeaders(admin: RpcClient, secretId: string) {
  let pending: Promise<Record<string, string>> | undefined;
  return () => {
    pending ??= (async () => {
      const { data, error } = await admin.rpc("crisp_get_workspace_secret", {
        p_secret_id: secretId,
      });
      if (error) throw new Error(`crisp_get_workspace_secret: ${error.message}`);
      const secret = data as Record<string, unknown> | null;
      const tokenId = secret?.token_id ?? secret?.tokenId;
      const tokenKey = secret?.token_key ?? secret?.tokenKey;
      if (!tokenId || !tokenKey) throw new Error("Workspace credentials missing");
      return {
        Authorization: `Basic ${btoa(`${tokenId}:${tokenKey}`)}`,
        "X-Crisp-Tier": "website",
        "Content-Type": "application/json",
      };
    })();
    return pending;
  };
}
