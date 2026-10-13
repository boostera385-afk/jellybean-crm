import { useEffect, useMemo, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Radio, Send, MapPin } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useCrispVisitors, CRISP_VISITORS_QUERY_KEY } from "@/hooks/use-crisp-visitors";
import type { CrispVisitor } from "@/lib/crisp.functions";

function playVisitorChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const beep = (freq: number, start: number, dur: number, vol = 0.36) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.02);
    };
    // A distinct rising sound makes a new live visitor easy to recognize.
    beep(659.25, 0.0, 0.12, 0.34); // E5
    beep(783.99, 0.11, 0.14, 0.36); // G5
    beep(987.77, 0.24, 0.22, 0.4); // B5
    setTimeout(() => ctx.close(), 1500);
  } catch {
    // Ignore audio context errors if blocked by browser policy
  }
}

function visitorKey(visitor: CrispVisitor): string {
  return `${visitor.crisp_website_id}:${visitor.crisp_session_id}`;
}

function visitorName(visitor: CrispVisitor): string {
  return visitor.nickname?.trim() || visitor.email?.trim() || "A visitor";
}

function visitorLocation(visitor: CrispVisitor): string {
  return [visitor.city, visitor.region, visitor.country].filter(Boolean).join(", ");
}

/**
 * Live-visitor notifications.
 *
 * Unlike the message notifier, these are not a dismissable queue: there is one
 * card per visitor who is currently live on a connected Crisp website, pinned
 * to the top of the screen (not the bottom-right corner). A card stays on
 * screen for exactly as long as that visitor is live — a realtime change on
 * crisp_visitors (with a slow poll fallback) refreshes the list, so when the
 * visitor leaves their card disappears on its own. The only action is "Send
 * Message", which jumps straight into the Crisp chat tab deep-linked to that
 * visitor so an operator can reach out.
 */
export function CrispVisitorAlerts() {
  const { roles, primaryRole, user } = useAuth();
  const navigate = useNavigate();

  const isCsAdmin =
    primaryRole === "cs_admin" || roles.includes("cs_admin") || roles.includes("admin");
  const canUseCrisp = isCsAdmin || primaryRole === "cs" || roles.includes("cs");

  // The crisp chat tab shows live visitors in its own right-hand rail, so the
  // corner toasts would be redundant there — hide them on that route only.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onCrispTab = pathname.startsWith("/app/crisp-chat");

  const queryClient = useQueryClient();

  // Realtime: push live-visitor changes instead of polling hard. Whenever a
  // crisp_visitors row changes (the sync/sweeper flips presence), refresh the
  // shared overview query once — debounced so a burst of row upserts coalesces
  // into a single refetch. This keeps the rail and corner alerts near-instant
  // while letting the fallback poll run slowly.
  useEffect(() => {
    if (!canUseCrisp || !user?.id) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const invalidateSoon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: CRISP_VISITORS_QUERY_KEY });
      }, 400);
    };
    const channel = supabase
      .channel("crisp-visitors-live-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisp_visitors" },
        invalidateSoon,
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [canUseCrisp, user?.id, queryClient]);

  const visitorOverview = useCrispVisitors(canUseCrisp && Boolean(user?.id));
  const liveVisitors = useMemo(
    () =>
      [...(visitorOverview.data?.liveVisitors ?? [])].sort((a, b) =>
        (b.first_seen_at || b.last_seen_at || "").localeCompare(
          a.first_seen_at || a.last_seen_at || "",
        ),
      ),
    [visitorOverview.data?.liveVisitors],
  );

  // Track which live visitors we have already chimed for so a fresh arrival
  // plays the sound once, while existing cards stay silent on each refresh.
  const chimedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!canUseCrisp || !user?.id) return;

    const currentKeys = new Set(liveVisitors.map(visitorKey));

    let hasNewVisitor = false;
    for (const key of currentKeys) {
      if (!chimedKeysRef.current.has(key)) {
        hasNewVisitor = true;
        break;
      }
    }

    // Drop keys for visitors that are no longer live so a returning visitor
    // chimes again, and keep the set bounded.
    chimedKeysRef.current = currentKeys;

    // On the crisp tab the rail already surfaces visitors, so stay silent there
    // (but keep the seen-set current so we don't chime a backlog on return).
    if (hasNewVisitor && !onCrispTab) {
      playVisitorChime();
    }
  }, [liveVisitors, canUseCrisp, user?.id, onCrispTab]);

  if (!canUseCrisp || onCrispTab || liveVisitors.length === 0) {
    return null;
  }

  const openChat = (visitor: CrispVisitor) => {
    navigate({
      to: "/app/crisp-chat",
      search: {
        websiteId: visitor.crisp_website_id,
        visitorSessionId: visitor.crisp_session_id,
      },
    });
  };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[95] flex max-w-[calc(100vw-2rem)] flex-col items-end">
      <div className="pointer-events-auto flex w-80 max-w-full flex-col gap-2 max-h-[50vh] overflow-y-auto overscroll-contain pr-0.5">

        {liveVisitors.map((visitor) => {
          const name = visitorName(visitor);
          const location = visitorLocation(visitor);
          const page = visitor.last_page_title || visitor.last_page_url || "";
          return (
            <div
              key={visitorKey(visitor)}
              className="flex w-full items-center gap-3 rounded-xl border border-emerald-500/30 bg-card/95 px-3.5 py-2.5 shadow-lg backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-200"
            >
              <div className="relative grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
                <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400 opacity-70 -right-0.5 -top-0.5" />
                <Radio className="h-4 w-4" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-foreground">{name}</span>
                  <span className="shrink-0 text-[11px] font-medium text-emerald-500">is live</span>
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {[visitor.workspace_name || "Crisp", location].filter(Boolean).join(" · ")}
                </p>
                {page && (
                  <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-foreground/70">
                    <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{page}</span>
                  </p>
                )}
              </div>

              <Button
                size="sm"
                className="h-8 shrink-0 gap-1.5 text-xs font-semibold"
                onClick={() => openChat(visitor)}
              >
                <Send className="h-3.5 w-3.5" />
                Send Message
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
