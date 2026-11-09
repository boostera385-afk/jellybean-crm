import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Radio, Send, MapPin, GripHorizontal } from "lucide-react";
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

/** Where the operator dragged the live-visitor stack, as distances from the
 *  bottom-right corner so it stays anchored the same way the default is. */
type AlertPosition = { right: number; bottom: number };
const POSITION_STORAGE_KEY = "crisp-visitor-alerts-position";
const DEFAULT_POSITION: AlertPosition = { right: 16, bottom: 16 };
const EDGE_GAP = 8;

function readStoredPosition(): AlertPosition {
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return DEFAULT_POSITION;
    const parsed = JSON.parse(raw) as Partial<AlertPosition>;
    if (Number.isFinite(parsed.right) && Number.isFinite(parsed.bottom))
      return { right: Number(parsed.right), bottom: Number(parsed.bottom) };
  } catch {
    // Storage blocked or corrupt: fall back to the default corner.
  }
  return DEFAULT_POSITION;
}

function storePosition(position: AlertPosition) {
  try {
    window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Storage blocked: the position simply is not remembered.
  }
}

/** Keep the whole stack on screen, whatever the window size is now. */
function clampPosition(position: AlertPosition, el: HTMLElement | null): AlertPosition {
  if (typeof window === "undefined") return position;
  const width = el?.offsetWidth ?? 320;
  const height = el?.offsetHeight ?? 80;
  const maxRight = Math.max(EDGE_GAP, window.innerWidth - width - EDGE_GAP);
  const maxBottom = Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP);
  return {
    right: Math.min(Math.max(position.right, EDGE_GAP), maxRight),
    bottom: Math.min(Math.max(position.bottom, EDGE_GAP), maxBottom),
  };
}

/**
 * Live-visitor notifications.
 *
 * Unlike the message notifier, these are not a dismissable queue: there is one
 * card per visitor who is currently live on a connected Crisp website, pinned
 * to the bottom-right below dialog surfaces, leaving save actions clear. A card stays on
 * screen for exactly as long as that visitor is live — a realtime change on
 * crisp_visitors (with a slow poll fallback) refreshes the list, so when the
 * visitor leaves their card disappears on its own. The only action is "Send
 * Message", which jumps straight into the Crisp chat tab deep-linked to that
 * visitor so an operator can reach out.
 *
 * The stack can be dragged anywhere on screen by its grip; the spot is kept
 * in this browser (double-click the grip to put it back in the corner).
 *
 * These cards are ambient, so they sit at z-40: BELOW the dialog layer. Every
 * dialog, sheet and alert-dialog is z-50, and the comboboxes that have to open
 * inside one are z-[70]/z-[80]. At z-[95] a visitor going live floated over an
 * open record and covered that dialog's own buttons, which is the one thing an
 * ambient notification must never do.
 */
export function CrispVisitorAlerts() {
  const { roles, primaryRole, user } = useAuth();
  const navigate = useNavigate();

  const isCsAdmin =
    primaryRole === "cs_admin" || roles.includes("cs_admin") || roles.includes("admin");
  const canUseCrisp = isCsAdmin || primaryRole === "cs" || roles.includes("cs");

  // The inbox rail replaces cards on desktop. Smaller screens still need cards
  // because that rail is hidden. Arrival sounds remain enabled in the inbox.
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
      performance.mark("crisp-presence-update");
      if (timer) return;
      // Long enough to coalesce one transaction's row upserts into a single
      // refetch, short enough not to be a visible part of the arrival delay.
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: CRISP_VISITORS_QUERY_KEY });
      }, 150);
    };
    // Deliberately only crisp_visitors. The counters live on crisp_workspaces,
    // but crisp_apply_event stamps last_seen_at on that row for EVERY event,
    // messages included, so subscribing to it refetches the whole overview on
    // all chat traffic. The counters are written in the same transaction as the
    // crisp_visitors row that triggers this, so they arrive anyway; a
    // reconcile-only correction waits for the fallback poll.
    const channel = supabase
      .channel("crisp-visitors-live-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisp_visitors" },
        invalidateSoon,
      )
      .subscribe((status) => {
        // Recover any changes missed during reconnect; this is a database read.
        if (status === "SUBSCRIBED") invalidateSoon();
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("Crisp presence connection interrupted; database refresh fallback active");
        }
      });
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [canUseCrisp, user?.id, queryClient]);

  // ── Drag to move ──────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<AlertPosition>(DEFAULT_POSITION);
  const dragRef = useRef<{ x: number; y: number; start: AlertPosition } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setPosition(readStoredPosition());
  }, []);

  // A remembered spot from a bigger window must not leave the stack off screen.
  useEffect(() => {
    const onResize = () => setPosition((p) => clampPosition(p, containerRef.current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onGripPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY, start: position };
      setDragging(true);
    },
    [position],
  );

  const onGripPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPosition(
      clampPosition(
        {
          right: drag.start.right - (e.clientX - drag.x),
          bottom: drag.start.bottom - (e.clientY - drag.y),
        },
        containerRef.current,
      ),
    );
  }, []);

  const onGripPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    setPosition((p) => {
      storePosition(p);
      return p;
    });
  }, []);

  const resetPosition = useCallback(() => {
    setPosition(DEFAULT_POSITION);
    storePosition(DEFAULT_POSITION);
  }, []);

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
  const chimedKeysRef = useRef<Map<string, number>>(new Map());
  const initializedRef = useRef(false);
  useEffect(() => {
    initializedRef.current = false;
    chimedKeysRef.current.clear();
  }, [user?.id]);

  useEffect(() => {
    if (!canUseCrisp || !user?.id || !visitorOverview.dataUpdatedAt) return;

    const currentKeys = new Set(liveVisitors.map(visitorKey));
    const now = Date.now();

    let hasNewVisitor = false;
    for (const key of currentKeys) {
      if (!chimedKeysRef.current.has(key)) {
        hasNewVisitor = true;
        break;
      }
    }

    // Brief absence must not replay a sound during refresh/reconnect. A genuine
    // return after the grace period can still alert, without an unbounded set.
    for (const key of currentKeys) chimedKeysRef.current.set(key, now);
    for (const [key, lastSeen] of chimedKeysRef.current) {
      if (!currentKeys.has(key) && now - lastSeen > 5_000) chimedKeysRef.current.delete(key);
    }
    // Initial cached sessions are not new arrivals. Sounds remain enabled in
    // the inbox; browser audio permissions may still require user interaction.
    if (initializedRef.current && hasNewVisitor) {
      playVisitorChime();
    }
    initializedRef.current = true;
    if (performance.getEntriesByName("crisp-presence-update").length) {
      const measurement = performance.measure(
        "crisp-presence-update-to-view",
        "crisp-presence-update",
      );
      console.debug("Crisp presence update to view", {
        durationMs: Math.round(measurement.duration),
      });
      performance.clearMarks("crisp-presence-update");
      // Browser-local measurement only; never include visitor/customer data.
      performance.clearMeasures("crisp-presence-update-to-view");
    }
  }, [liveVisitors, canUseCrisp, user?.id, visitorOverview.dataUpdatedAt]);

  if (!canUseCrisp || liveVisitors.length === 0) {
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
    <div
      ref={containerRef}
      style={{ right: position.right, bottom: position.bottom }}
      className={`pointer-events-none fixed z-40 flex max-w-[calc(100vw-1rem)] flex-col items-end ${onCrispTab ? "lg:hidden" : ""}`}
    >
      <div
        role="button"
        tabIndex={-1}
        aria-label="Drag to move live visitor alerts. Double-click to reset."
        title="Drag to move · double-click to reset"
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={onGripPointerUp}
        onPointerCancel={onGripPointerUp}
        onDoubleClick={resetPosition}
        className={`pointer-events-auto mb-1 flex h-5 w-80 max-w-full touch-none select-none items-center justify-center rounded-md border border-border/60 bg-card/90 text-muted-foreground shadow-sm backdrop-blur-xl hover:text-foreground ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
      >
        <GripHorizontal className="h-3.5 w-3.5" />
      </div>
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
