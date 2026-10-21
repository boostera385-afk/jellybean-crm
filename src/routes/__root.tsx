import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { supabase } from "@/integrations/supabase/client";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "JellyBean" },
      { name: "description", content: "JellyBean lead operations workspace" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "theme-color", content: "#090d17" },
      { property: "og:title", content: "JellyBean" },
      { name: "twitter:title", content: "JellyBean" },
      { property: "og:description", content: "JellyBean lead operations workspace" },
      { name: "twitter:description", content: "JellyBean lead operations workspace" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Public+Sans:wght@400..800&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg?v=2" },
      { rel: "shortcut icon", href: "/favicon.svg?v=2" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: ErrorView,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=document.documentElement;d.classList.remove('dark','light');d.classList.add(t==='light'?'light':'dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster richColors position="bottom-right" />
      <ConfirmDialogProvider />
    </QueryClientProvider>
  );
}

function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="text-center">
        <h1 className="text-7xl font-semibold tracking-tight">404</h1>
        <p className="text-muted-foreground mt-3">This page doesn't exist.</p>
        <a href="/" className="inline-block mt-5 text-primary hover:text-primary-glow transition">
          Back home →
        </a>
      </div>
    </div>
  );
}

function ErrorView({ error }: ErrorComponentProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="text-center max-w-md glass-card p-8">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground mt-2">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <a href="/" className="inline-block mt-5 text-primary hover:text-primary-glow transition">
          Reload →
        </a>
      </div>
    </div>
  );
}
