import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, Loader2, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClockSkew } from "@/hooks/use-clock-skew";
import jellybeanLogo from "@/assets/jellybean-logo.png";
import { ThemeToggle } from "@/components/theme-toggle";

type LoginProfile = {
  is_active: boolean;
};

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign In \u00b7 JellyBean" },
      { name: "description", content: "Sign in to your JellyBean CRM account." },
      { property: "og:title", content: "Sign In \u00b7 JellyBean" },
      { property: "og:description", content: "Sign in to your JellyBean CRM account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const skewSeconds = useClockSkew();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [profilesExist, setProfilesExist] = useState(true);

  useEffect(() => {
    // Non-blocking: check if any profiles exist so we can show the
    // first-run setup link. Runs after the form is already interactive.
    let cancelled = false;
    void (async () => {
      try {
        const { count } = await supabase
          .from("profiles")
          .select("id", { count: "exact", head: true });
        if (!cancelled) setProfilesExist((count ?? 0) > 0);
      } catch (err) {
        console.error(err);
      }
    })();

    // If the user already has a session, jump straight to the app.
    void (async () => {
      const { data: sess } = await supabase.auth.getSession();
      if (cancelled || !sess.session) return;
      const access = await getLoginAccess(sess.session.user.id);
      if (!access.isActive) {
        await supabase.auth.signOut();
        toast.error("Your account is inactive. Please contact an administrator.");
        return;
      }
      navigate({ to: "/app" });
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function getLoginAccess(uid: string): Promise<{ isActive: boolean }> {
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_active")
      .eq("user_id", uid)
      .maybeSingle();
    return {
      isActive: (profile as LoginProfile | null)?.is_active ?? false,
    };
  }

  async function resolveEmail(id: string): Promise<string | null> {
    const trimmed = id.trim();
    if (trimmed.includes("@")) return trimmed;
    const { data, error } = await supabase.rpc("email_for_username", { _username: trimmed });
    if (error) return null;
    return (data as string | null) ?? null;
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const email = await resolveEmail(identifier);
      if (!email) {
        toast.error("No account found for that email or username");
        return;
      }
      // signInWithPassword returns the user — no need for a second getUser() call.
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        const msg = error.message;
        toast.error(msg && msg !== "{}" ? msg : "Invalid login credentials or server error");
        return;
      }
      const user = data.user;
      if (user) {
        const access = await getLoginAccess(user.id);
        if (!access.isActive) {
          await supabase.auth.signOut();
          toast.error("Your account is inactive. Please contact an administrator.");
          return;
        }
      }
      navigate({ to: "/app" });
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as Error)?.message || String(err);
      toast.error(msg === "{}" ? "An unexpected error occurred" : msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 flex items-center justify-center">
      <ThemeToggle className="fixed right-4 top-4 z-20 h-10 w-10 justify-center border border-border bg-card/80 p-0 shadow-sm backdrop-blur-xl [&>span]:hidden" />
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_22%_14%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_30rem)]" />
      <div className="w-full max-w-5xl grid overflow-hidden rounded-[32px] border border-border bg-card/90 shadow-lg backdrop-blur-xl md:grid-cols-[0.9fr_1fr] animate-fade-in-up">
        <section className="hidden md:flex flex-col justify-between bg-[linear-gradient(135deg,color-mix(in_oklch,var(--primary)_88%,black),color-mix(in_oklch,var(--primary-glow)_72%,var(--surface)))] p-9 text-primary-foreground">
          <div>
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-2xl bg-white/95 ring-1 ring-white/30 grid place-items-center shadow-sm overflow-hidden">
                <img
                  src={jellybeanLogo}
                  alt="JellyBean logo"
                  width={44}
                  height={44}
                  className="h-8 w-8 object-contain"
                />
              </div>
              <div>
                <div className="text-lg font-semibold tracking-tight">JellyBean</div>
                <div className="text-sm text-primary-foreground/80">Lead operations CRM</div>
              </div>
            </div>
            <div className="mt-16 max-w-sm">
              <h1 className="text-[34px] leading-[1.05] font-bold tracking-[-0.02em]">
                Manage every lead from one calm workspace.
              </h1>
              <p className="mt-4 text-sm leading-6 text-primary-foreground/90">
                Review raw leads, forward qualified jobs, and keep CS follow-up moving without extra
                login codes.
              </p>
            </div>
          </div>
          <div className="grid gap-3 text-sm text-primary-foreground/90">
            {["Password-only access", "Role-based CRM views", "Live Supabase lead data"].map(
              (item) => (
                <div key={item} className="flex items-center gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-primary-foreground" />
                  <span>{item}</span>
                </div>
              ),
            )}
          </div>
        </section>

        <section className="p-7 sm:p-10 md:p-12 bg-card/72">
          <div className="md:hidden mb-8 flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-primary grid place-items-center overflow-hidden">
              <img
                src={jellybeanLogo}
                alt="JellyBean logo"
                width={44}
                height={44}
                className="h-8 w-8 object-contain"
              />
            </div>
            <div>
              <div className="text-lg font-semibold tracking-tight">JellyBean</div>
              <div className="text-sm text-muted-foreground">Lead operations CRM</div>
            </div>
          </div>

          <div className="max-w-md mx-auto">
            {skewSeconds !== null && (
              <div className="mb-6 p-4 rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200 text-sm shadow-sm flex flex-col gap-2 animate-fade-in">
                <div className="flex items-center gap-2 font-semibold">
                  <span className="text-base">⚠️</span>
                  <span>System Clock Out of Sync</span>
                </div>
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  Your computer's clock is out of sync with our servers by about{" "}
                  <strong>{Math.round(Math.abs(skewSeconds) / 60)} minutes</strong>. This causes
                  security validation checks to fail, leading to rapid logouts (HTTP 429 Too Many
                  Requests).
                </p>
                <p className="text-xs font-medium mt-1">
                  <strong>To fix this:</strong> Open your device's{" "}
                  <strong>Date & Time settings</strong> and turn on{" "}
                  <strong>"Set time automatically"</strong>, then refresh this page.
                </p>
              </div>
            )}

            <div className="mb-8">
              <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-primary">
                Welcome back
              </p>
              <h1 className="mt-2 text-[30px] leading-tight font-bold tracking-[-0.02em]">
                Sign in to your workspace
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Use your assigned email or username and password.
              </p>
            </div>

            <form onSubmit={handleSignIn} className="space-y-5">
              <div>
                <Label htmlFor="id" className="text-[13px] font-medium text-foreground">
                  Email or username
                </Label>
                <Input
                  id="id"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                  className="mt-2 h-12 rounded-xl bg-input text-foreground border-border"
                />
              </div>
              <div>
                <Label htmlFor="pw" className="text-[13px] font-medium text-foreground">
                  Password
                </Label>
                <div className="relative mt-2">
                  <Input
                    id="pw"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="h-12 rounded-xl bg-input text-foreground border-border pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <Button
                type="submit"
                className="w-full h-12 rounded-xl text-[15px] shadow-[0_12px_28px_-16px_rgba(37,99,235,0.8)]"
                disabled={submitting}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Sign in
                {!submitting && <ArrowRight className="h-4 w-4" />}
              </Button>
              <p className="text-[12.5px] text-muted-foreground text-center pt-2">
                Accounts are provisioned by your administrator.
              </p>
              {!profilesExist && (
                <div className="text-center pt-4 border-t border-border mt-4">
                  <Link to="/setup" className="text-xs text-primary hover:underline font-medium">
                    First time? Set up your admin account
                  </Link>
                </div>
              )}
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
