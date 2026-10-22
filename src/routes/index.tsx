import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "JellyBean CRM" },
      { name: "description", content: "Access the JellyBean lead operations workspace." },
      { property: "og:title", content: "JellyBean CRM" },
      { property: "og:description", content: "Access the JellyBean lead operations workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: IndexRedirect,
});

function IndexRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession();
      navigate({ to: data.session ? "/app" : "/login", replace: true });
    })();
  }, [navigate]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
