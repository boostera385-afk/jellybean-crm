import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivity } from "@/lib/activity-log";

// Optional, role-independent features an admin can grant to individual users.
// Adding a new feature here is all that's needed to expose it in the
// Settings -> Feature Access matrix.
export const MANAGED_FEATURES = ["analytics", "reports"] as const;
export type ManagedFeature = (typeof MANAGED_FEATURES)[number];

const MANAGED_FEATURE_SET = new Set<string>(MANAGED_FEATURES);
const featureSchema = z.enum(MANAGED_FEATURES);

// Features a role already includes without an explicit grant. Mirrors the
// sidebar in app-shell.tsx: admin and sub-admin see Analytics and Reports by
// default. Users whose roles already cover every managed feature are left out
// of the Feature Access list entirely (nothing to grant).
const ROLE_FEATURE_DEFAULTS: Record<string, ManagedFeature[]> = {
  admin: ["analytics", "reports"],
  sub_admin: ["analytics", "reports"],
};

function roleFeaturesFor(roles: string[]): ManagedFeature[] {
  const set = new Set<ManagedFeature>();
  for (const role of roles) {
    for (const feature of ROLE_FEATURE_DEFAULTS[role] ?? []) set.add(feature);
  }
  return MANAGED_FEATURES.filter((feature) => set.has(feature));
}

async function requireAdmin(userId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const isAdmin = (data ?? []).some((row) => String(row.role) === "admin");
  if (!isAdmin) throw new Error("Forbidden: admin access required");
}

async function loadActorName(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("full_name, username, email")
      .eq("user_id", userId)
      .maybeSingle();
    return data?.full_name || data?.username || data?.email || null;
  } catch {
    return null;
  }
}

export type FeatureAccessUserRow = {
  user_id: string;
  full_name: string;
  username: string | null;
  email: string;
  role: string | null;
  /** Features explicitly granted via Feature Access. */
  features: ManagedFeature[];
  /** Features the user already has from their role (shown on + locked). */
  roleFeatures: ManagedFeature[];
};

// Admin-only: every user plus the set of managed features currently granted.
export const listFeatureAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FeatureAccessUserRow[]> => {
    await requireAdmin(context.userId);

    const [
      { data: profiles, error: profilesError },
      { data: roleRows, error: rolesError },
      { data: flagRows, error: flagsError },
    ] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("user_id, full_name, username, email, created_at")
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("user_roles").select("user_id, role"),
      supabaseAdmin.from("user_feature_access").select("user_id, feature, enabled"),
    ]);
    if (profilesError) throw new Error(profilesError.message);
    if (rolesError) throw new Error(rolesError.message);
    if (flagsError) throw new Error(flagsError.message);

    const rolesByUser = new Map<string, string[]>();
    for (const row of roleRows ?? []) {
      const roles = rolesByUser.get(row.user_id) ?? [];
      roles.push(String(row.role));
      rolesByUser.set(row.user_id, roles);
    }

    const featuresByUser = new Map<string, Set<string>>();
    for (const row of flagRows ?? []) {
      if (!row.enabled) continue;
      if (!MANAGED_FEATURE_SET.has(String(row.feature))) continue;
      const set = featuresByUser.get(row.user_id) ?? new Set<string>();
      set.add(String(row.feature));
      featuresByUser.set(row.user_id, set);
    }

    return (
      (profiles ?? [])
        .map((profile) => {
          const roles = rolesByUser.get(profile.user_id) ?? [];
          const granted = featuresByUser.get(profile.user_id) ?? new Set<string>();
          const roleFeatures = roleFeaturesFor(roles);
          return {
            user_id: profile.user_id,
            full_name: profile.full_name,
            username: profile.username,
            email: profile.email,
            role: roles[0] ?? null,
            features: MANAGED_FEATURES.filter((feature) => granted.has(feature)),
            roleFeatures,
          } satisfies FeatureAccessUserRow;
        })
        // Drop users whose role already covers every managed feature (admins);
        // there is nothing to grant them here.
        .filter((row) => row.roleFeatures.length < MANAGED_FEATURES.length)
    );
  });

// Admin-only: grant (enabled=true, upsert) or revoke (enabled=false, delete)
// a managed feature for a single user.
export const setFeatureAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        userId: z.string().uuid(),
        feature: featureSchema,
        enabled: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);

    if (data.enabled) {
      const { error } = await supabaseAdmin.from("user_feature_access").upsert(
        {
          user_id: data.userId,
          feature: data.feature,
          enabled: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,feature" },
      );
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin
        .from("user_feature_access")
        .delete()
        .eq("user_id", data.userId)
        .eq("feature", data.feature);
      if (error) throw new Error(error.message);
    }

    await logActivity({
      supabaseAdmin,
      actorId: context.userId,
      actorName: await loadActorName(context.userId),
      actorRole: "admin",
      action: "set_user_feature_access",
      entityType: "user_feature_access",
      metadata: { targetUserId: data.userId, feature: data.feature, enabled: data.enabled },
    });

    return { ok: true };
  });
