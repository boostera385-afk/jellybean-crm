/**
 * Recognises a session that is no longer usable.
 *
 * `requireSupabaseAuth` (src/integrations/supabase/auth-middleware.ts, a
 * generated file) rejects a missing, malformed or expired bearer token by
 * throwing a plain Error, so TanStack delivers it to the browser as HTTP 500
 * rather than 401. The app shell polls Crisp presence on every CRM page, so one
 * stale session becomes a stream of 500s that the error boundary renders as a
 * blank page. Only the messages that middleware actually throws are matched
 * here: anything else is a real bug and must still surface.
 */
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const AUTH_FAILURES = [
  "Unauthorized: No request headers available",
  "Unauthorized: No authorization header provided",
  "Unauthorized: Only Bearer tokens are supported",
  "Unauthorized: No token provided",
  "Unauthorized: Invalid token",
  "Unauthorized: No user ID found in token",
] as const;

export function isAuthExpiredError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return AUTH_FAILURES.some((failure) => message.includes(failure));
}

let handled = false;
let resetOnSignIn: Promise<unknown> | null = null;

/**
 * Ends the stale session once, so a background poll cannot blank the screen or
 * stack toasts. The flag clears on the next sign-in, so a session that expires
 * again later is handled again.
 */
export function handleAuthExpired(): void {
  if (typeof window === "undefined" || handled) return;
  handled = true;

  if (!resetOnSignIn) {
    resetOnSignIn = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") handled = false;
    }).data.subscription;
  }

  toast.error("Your session expired. Please sign in again.");
  void supabase.auth.signOut();
}
