import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireTargetAccess, requireUserManager } from "@/lib/admin-users.functions";

// User managers may only delete accounts inside their delegated role scope.
export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ userId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const actorRole = await requireUserManager(context.userId);
    // fb_admin may create and manage FB submitters but never delete anyone.
    if (actorRole === "fb_admin") {
      throw new Error("Forbidden: fb_admin cannot delete users");
    }
    if (data.userId === context.userId) throw new Error("You cannot delete your own account.");
    await requireTargetAccess(actorRole, data.userId);

    // Hard-delete from auth first. FKs to auth.users(id) are ON DELETE CASCADE
    // for user_roles/profiles, so this removes them too. Explicitly pass
    // shouldSoftDelete=false so the row is fully removed, not just marked.
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(data.userId, false);
    if (authErr) {
      console.error("[adminDeleteUser] auth.admin.deleteUser failed", authErr);
      throw new Error(`Failed to delete user: ${authErr.message}`);
    }

    // Belt-and-suspenders: if the FK cascade didn't run for any reason,
    // clean up app rows explicitly and surface any error.
    const { error: rolesErr } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.userId);
    if (rolesErr) console.error("[adminDeleteUser] user_roles cleanup failed", rolesErr);
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("user_id", data.userId);
    if (profErr) console.error("[adminDeleteUser] profiles cleanup failed", profErr);

    return { ok: true };
  });
