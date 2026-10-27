import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AppRole =
  | "admin"
  | "sub_admin"
  | "scraping"
  | "maturing"
  | "cs"
  | "cs_admin"
  | "acc_handler"
  | "facebook"
  | "seo";

export interface AuthProfile {
  id: string;
  user_id: string;
  full_name: string;
  username: string | null;
  email: string;
  is_active: boolean;
}

export interface AuthState {
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  roles: AppRole[];
  primaryRole: AppRole | null;
  /** Optional, role-independent features granted to this user (e.g. "analytics"). */
  features: string[];
  accessCodeVerified: boolean;
  accessCodeChecking: boolean;
  refreshAccessCode: () => Promise<void>;
  markAccessCodeVerified: () => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuthState(): AuthState {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [features, setFeatures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [accessCodeVerified, setAccessCodeVerified] = useState(false);
  const [accessCodeChecking, setAccessCodeChecking] = useState(false);
  const latestSessionRef = useRef<Session | null>(null);

  const loadProfileAndRoles = useCallback(async (uid: string | undefined) => {
    if (!uid) {
      setProfile(null);
      setRoles([]);
      setFeatures([]);
      return;
    }
    const [
      { data: prof, error: profileError },
      { data: rolesData, error: rolesError },
      { data: featureData, error: featuresError },
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, user_id, full_name, username, email, is_active")
        .eq("user_id", uid)
        .maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", uid),
      supabase.from("user_feature_access").select("feature").eq("user_id", uid).eq("enabled", true),
    ]);
    if (profileError) throw profileError;
    if (rolesError) throw rolesError;
    // Feature grants are optional; never block sign-in if the lookup fails.
    if (featuresError) console.error("[Auth] Could not load feature access", featuresError);
    setProfile((prof as AuthProfile | null) ?? null);
    setRoles(((rolesData as { role: AppRole }[] | null) ?? []).map((r) => r.role));
    setFeatures(((featureData as { feature: string }[] | null) ?? []).map((row) => row.feature));
  }, []);

  useEffect(() => {
    let cancelled = false;

    // `onAuthStateChange` immediately fires `INITIAL_SESSION` on setup,
    // so we don't need a redundant `getSession()` call.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      if (cancelled) return;
      latestSessionRef.current = sess;
      setSession(sess);
      setUser(sess?.user ?? null);

      // Load profile and roles, then clear loading state
      withTimeout(loadProfileAndRoles(sess?.user?.id), 20000, "Supabase profile lookup")
        .catch((error) => {
          console.error("[Auth] Could not initialize profile", error);
          if (!latestSessionRef.current) {
            setProfile(null);
            setRoles([]);
            setFeatures([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [loadProfileAndRoles]);

  const refresh = useCallback(async () => {
    await loadProfileAndRoles(user?.id);
  }, [user?.id, loadProfileAndRoles]);

  const refreshAccessCode = useCallback(async () => {
    if (!latestSessionRef.current) {
      setAccessCodeVerified(false);
      return;
    }
    setAccessCodeChecking(true);
    try {
      const { data, error } = await supabase.rpc("is_my_access_verified" as never);
      if (error) throw error;
      setAccessCodeVerified(!!data);
    } catch (err) {
      console.error("[Auth] access code check failed", err);
      setAccessCodeVerified(false);
    } finally {
      setAccessCodeChecking(false);
    }
  }, []);

  const markAccessCodeVerified = useCallback(() => setAccessCodeVerified(true), []);

  const signOut = useCallback(async () => {
    setAccessCodeVerified(false);
    await supabase.auth.signOut();
  }, []);

  // Re-check verification whenever the auth session identity changes.
  useEffect(() => {
    if (!session) {
      setAccessCodeVerified(false);
      return;
    }
    void refreshAccessCode();
  }, [session?.access_token, session, refreshAccessCode]);

  const primaryRole: AppRole | null = roles.includes("admin")
    ? "admin"
    : roles.includes("sub_admin")
      ? "sub_admin"
      : roles.includes("cs_admin")
        ? "cs_admin"
        : roles.includes("scraping")
          ? "scraping"
          : roles.includes("maturing")
            ? "maturing"
            : roles.includes("cs")
              ? "cs"
              : roles.includes("acc_handler")
                ? "acc_handler"
                : roles.includes("facebook")
                  ? "facebook"
                  : roles.includes("seo")
                    ? "seo"
                    : null;

  return {
    loading,
    session,
    user,
    profile,
    roles,
    primaryRole,
    features,
    accessCodeVerified,
    accessCodeChecking,
    refreshAccessCode,
    markAccessCodeVerified,
    refresh,
    signOut,
  };
}

export function AuthProvider({ value, children }: { value: AuthState; children: ReactNode }) {
  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth must be used inside AuthProvider");
  return auth;
}
