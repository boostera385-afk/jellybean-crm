import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useServerFn } from "@tanstack/react-start";
import { bootstrapFirstAdmin } from "@/lib/admin-users.functions";
import { friendlyError } from "@/lib/error-messages";
import jellybeanLogo from "@/assets/jellybean-logo.png";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [
      { title: "Account Setup \u00b7 JellyBean" },
      { name: "description", content: "Complete your JellyBean CRM account setup." },
      { property: "og:title", content: "Account Setup \u00b7 JellyBean" },
      { property: "og:description", content: "Complete your JellyBean CRM account setup." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SetupPage,
});

function SetupPage() {
  const bootstrap = useServerFn(bootstrapFirstAdmin);
  const [checking, setChecking] = useState(true);
  const [profilesExist, setProfilesExist] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

  useEffect(() => {
    async function checkProfiles() {
      try {
        const { count, error } = await supabase
          .from("profiles")
          .select("id", { count: "exact", head: true });
        if (error) throw error;
        setProfilesExist((count ?? 0) > 0);
      } catch (err) {
        toast.error("Failed to verify system status.");
      } finally {
        setChecking(false);
      }
    }
    checkProfiles();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < 8) {
      toast.error("Password must be at least 8 characters long.");
      return;
    }
    if (form.password !== form.confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await bootstrap({
        data: {
          fullName: form.fullName,
          email: form.email,
          password: form.password,
          role: "admin",
          isActive: true,
        },
      });
      setSuccess(true);
      toast.success("Admin account created successfully!");
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-[linear-gradient(135deg,#f7fbff_0%,#eef5ff_48%,#ffffff_100%)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Checking system status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 flex items-center justify-center">
      <ThemeToggle className="fixed right-4 top-4 z-20 h-10 w-10 justify-center border border-border bg-card/80 p-0 shadow-sm backdrop-blur-xl [&>span]:hidden" />
      <div className="w-full max-w-5xl grid overflow-hidden rounded-[28px] border border-border/80 bg-card/95 shadow-[0_32px_90px_-50px_rgba(0,0,0,0.45)] backdrop-blur-xl md:grid-cols-[0.92fr_1fr] animate-fade-in-up">
        <section className="hidden md:flex flex-col justify-between bg-primary p-9 text-primary-foreground">
          <div>
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-2xl bg-card ring-1 ring-border/20 grid place-items-center overflow-hidden">
                <img
                  src={jellybeanLogo}
                  alt="JellyBean logo"
                  width={44}
                  height={44}
                  className="h-8 w-8 object-contain"
                />
              </div>
              <div>
                <div className="font-bold tracking-tight text-primary-foreground">JellyBean</div>
                <div className="text-sm text-primary-foreground/80">Lead operations CRM</div>
              </div>
            </div>
            <div className="mt-16 max-w-sm">
              <h1 className="text-[28px] font-bold leading-tight tracking-tight text-primary-foreground">
                Set up the main owner account.
              </h1>
              <p className="mt-4 text-sm leading-6 text-primary-foreground/90">
                You are setting up the initial admin user. This account will have full access to
                manage roles and system configurations.
              </p>
            </div>
          </div>
          <div className="grid gap-3 text-sm text-primary-foreground/90">
            {["Full system access", "Manage user roles", "Configure settings"].map((item) => (
              <div key={item} className="flex items-center gap-2.5">
                <CheckCircle2 className="h-4 w-4 text-primary-foreground" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Right Side Form */}
        <section className="p-7 sm:p-10 md:p-12">
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
            {profilesExist ? (
              <div className="text-center py-8">
                <h2 className="text-2xl font-bold tracking-tight">Setup Complete</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Setup is already complete. Please sign in to access your account.
                </p>
                <Button asChild className="mt-6 w-full h-12 rounded-xl">
                  <Link to="/login">
                    Sign In <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
            ) : success ? (
              <div className="text-center py-8">
                <div className="h-12 w-12 rounded-full bg-success/20 text-success grid place-items-center mx-auto mb-4">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight">Account Created</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Admin account created. You can now sign in to your workspace.
                </p>
                <Button asChild className="mt-6 w-full h-12 rounded-xl">
                  <Link to="/login">
                    Go to Sign In <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
            ) : (
              <div>
                <div className="mb-8">
                  <p className="text-sm font-medium text-primary">Initial Configuration</p>
                  <h1 className="mt-2 text-[30px] leading-tight font-semibold tracking-[-0.02em]">
                    Create Admin Account
                  </h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Create the first account. This account will automatically have administrative
                    privileges.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <Label htmlFor="fullName" className="text-[13px] font-medium text-foreground">
                      Full Name
                    </Label>
                    <Input
                      id="fullName"
                      value={form.fullName}
                      onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                      required
                      className="mt-2 h-12 rounded-xl bg-input text-foreground border-border"
                      placeholder="e.g. John Doe"
                    />
                  </div>

                  <div>
                    <Label htmlFor="email" className="text-[13px] font-medium text-foreground">
                      Email Address
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      required
                      className="mt-2 h-12 rounded-xl bg-input text-foreground border-border"
                      placeholder="e.g. admin@leadgrid.com"
                    />
                  </div>

                  <div>
                    <Label htmlFor="pw" className="text-[13px] font-medium text-foreground">
                      Password
                    </Label>
                    <Input
                      id="pw"
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      required
                      className="mt-2 h-12 rounded-xl bg-input text-foreground border-border"
                      placeholder="At least 8 characters"
                    />
                  </div>

                  <div>
                    <Label htmlFor="confirmPw" className="text-[13px] font-medium text-foreground">
                      Confirm Password
                    </Label>
                    <Input
                      id="confirmPw"
                      type="password"
                      value={form.confirmPassword}
                      onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                      required
                      className="mt-2 h-12 rounded-xl bg-input text-foreground border-border"
                      placeholder="Repeat your password"
                    />
                  </div>

                  <Button
                    type="submit"
                    className="w-full h-12 rounded-xl text-[15px] shadow-[0_12px_28px_-16px_rgba(37,99,235,0.8)] mt-2"
                    disabled={submitting}
                  >
                    {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                    Complete Setup
                    {!submitting && <ArrowRight className="h-4 w-4 ml-2" />}
                  </Button>
                </form>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
