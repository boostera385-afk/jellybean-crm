import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare, X, ExternalLink, Layers } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCrispVisitors } from "@/hooks/use-crisp-visitors";
import { toast } from "sonner";

function isCrispMaskedMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const stripped = trimmed.replace(/[\s\p{P}\p{S}]/gu, "");
  return stripped.length >= 3 && /^x+$/i.test(stripped);
}

function playCrispChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const beep = (freq: number, start: number, dur: number, vol = 0.4) => {
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
    // Clean double-tone notification chime
    beep(587.33, 0.0, 0.14); // D5
    beep(880.0, 0.14, 0.22); // A5
    setTimeout(() => ctx.close(), 1500);
  } catch {
    // Ignore audio context errors if blocked by browser policy
  }
}

type QueuedMessageAlert = {
  id: string;
  conversationId: string;
  customerName: string;
  workspaceName: string;
  messageSnippet: string;
  receivedAt: string;
};

function getDismissedNotificationKeys(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`crisp_dismissed_alerts_${userId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function addDismissedNotificationKeys(userId: string, keys: string[]) {
  try {
    const current = getDismissedNotificationKeys(userId);
    keys.forEach((k) => current.add(k));
    const arr = Array.from(current).slice(-200);
    localStorage.setItem(`crisp_dismissed_alerts_${userId}`, JSON.stringify(arr));
  } catch {
    // Ignore localStorage errors
  }
}

export function CrispMessageNotifier() {
  const { roles, primaryRole, user } = useAuth();
  const navigate = useNavigate();

  const isCsAdmin =
    primaryRole === "cs_admin" || roles.includes("cs_admin") || roles.includes("admin");
  const canUseCrisp = isCsAdmin || primaryRole === "cs" || roles.includes("cs");
  const visitorOverview = useCrispVisitors(canUseCrisp && Boolean(user?.id));

  const seenMsgIdsRef = useRef<Set<string>>(new Set());
  const notifiedVisitorIdsRef = useRef<Set<string>>(new Set());
  const [activeQueue, setActiveQueue] = useState<QueuedMessageAlert[]>([]);

  useEffect(() => {
    if (!canUseCrisp || !user?.id || !visitorOverview.data?.fetchedAt) return;

    const storageKey = `crisp_live_visitor_alerts_${user.id}`;
    if (notifiedVisitorIdsRef.current.size === 0) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
        if (Array.isArray(stored)) {
          notifiedVisitorIdsRef.current = new Set(stored.map(String));
        }
      } catch {
        // Session storage is an optional notification convenience.
      }
    }

    const newVisitors = visitorOverview.data.liveVisitors.filter((visitor) => {
      const key = `${visitor.crisp_website_id}:${visitor.crisp_session_id}`;
      return !notifiedVisitorIdsRef.current.has(key);
    });
    if (newVisitors.length === 0) return;

    newVisitors.forEach((visitor) => {
      notifiedVisitorIdsRef.current.add(`${visitor.crisp_website_id}:${visitor.crisp_session_id}`);
    });
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(Array.from(notifiedVisitorIdsRef.current).slice(-500)),
      );
    } catch {
      // Session storage is optional.
    }

    playCrispChime();
    if (newVisitors.length === 1) {
      const visitor = newVisitors[0];
      const location = [visitor.city, visitor.region, visitor.country].filter(Boolean).join(", ");
      toast.info(`${visitor.nickname || "A visitor"} is live`, {
        description: [visitor.workspace_name || "Crisp", location, visitor.last_page_title]
          .filter(Boolean)
          .join(" · "),
        duration: 10_000,
        action: {
          label: "Open Crisp",
          onClick: () => navigate({ to: "/app/crisp-chat" }),
        },
      });
    } else {
      toast.info(`${newVisitors.length} visitors are live now`, {
        description: "Open Crisp Chat to see their pages, locations, and start a conversation.",
        duration: 10_000,
        action: {
          label: "View visitors",
          onClick: () => navigate({ to: "/app/crisp-chat" }),
        },
      });
    }
  }, [canUseCrisp, navigate, user?.id, visitorOverview.data]);

  const handleDismissTop = () => {
    const item = activeQueue[0];
    if (item && user?.id) {
      addDismissedNotificationKeys(user.id, [item.id]);
    }
    setActiveQueue((prev) => prev.slice(1));
  };

  const handleDismissAll = () => {
    if (user?.id && activeQueue.length > 0) {
      addDismissedNotificationKeys(
        user.id,
        activeQueue.map((a) => a.id),
      );
    }
    setActiveQueue([]);
  };

  const handleViewChat = (_conversationId?: string) => {
    const item = activeQueue[0];
    if (item && user?.id) {
      addDismissedNotificationKeys(user.id, [item.id]);
    }
    setActiveQueue((prev) => prev.slice(1));
    navigate({ to: "/app/crisp-chat" });
  };

  // CHECK UNREAD CONVERSATIONS (On login & on tab focus/switch)
  const checkUnreadAndQueue = useCallback(async () => {
    if (!isCsAdmin || !user?.id) return;

    try {
      const { data: unreadConvs } = await supabase
        .from("crisp_conversations")
        .select("id, customer_name, crisp_website_id, last_message, last_message_at, unread_count")
        .gt("unread_count", 0)
        .order("last_message_at", { ascending: false })
        .limit(10);

      if (!unreadConvs || unreadConvs.length === 0) return;

      const validUnread = unreadConvs.filter((c) => !isCrispMaskedMessage(c.last_message));
      if (validUnread.length === 0) return;

      const websiteIds = Array.from(
        new Set(validUnread.map((c) => c.crisp_website_id).filter(Boolean)),
      );
      const wsMap = new Map<string, string>();
      if (websiteIds.length > 0) {
        const { data: wsRows } = await supabase
          .from("crisp_workspaces")
          .select("crisp_website_id, workspace_name")
          .in("crisp_website_id", websiteIds);
        (wsRows ?? []).forEach((w) => {
          if (w.workspace_name?.trim()) wsMap.set(w.crisp_website_id, w.workspace_name.trim());
        });
      }

      const dismissedKeys = getDismissedNotificationKeys(user.id);
      const newAlerts: QueuedMessageAlert[] = [];

      for (const conv of validUnread) {
        const seenKey = `unread_conv_${conv.id}_${conv.last_message_at}`;
        if (seenMsgIdsRef.current.has(seenKey) || dismissedKeys.has(seenKey)) continue;
        seenMsgIdsRef.current.add(seenKey);

        const customerName = conv.customer_name?.trim() || "Customer";
        const workspaceName = wsMap.get(conv.crisp_website_id) || "Crisp";
        const messageSnippet =
          conv.last_message && conv.last_message.length > 220
            ? `${conv.last_message.slice(0, 220)}...`
            : conv.last_message || "New unread customer message";

        const receivedAt = conv.last_message_at
          ? new Date(conv.last_message_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        newAlerts.push({
          id: seenKey,
          conversationId: conv.id,
          customerName,
          workspaceName,
          messageSnippet,
          receivedAt,
        });
      }

      if (newAlerts.length > 0) {
        playCrispChime();
        setActiveQueue((prev) => {
          const existingIds = new Set(prev.map((a) => a.id));
          const additions = newAlerts.filter((a) => !existingIds.has(a.id));
          return [...prev, ...additions];
        });
      }
    } catch {
      // Non-fatal
    }
  }, [isCsAdmin, user?.id]);

  // Check unread on login / initial mount
  useEffect(() => {
    void checkUnreadAndQueue();
  }, [checkUnreadAndQueue]);

  // Check unread when user switches back to CRM tab (visibilitychange / focus)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void checkUnreadAndQueue();
      }
    };
    const handleFocus = () => {
      void checkUnreadAndQueue();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [checkUnreadAndQueue]);

  // REALTIME INCOMING MESSAGE LISTENER (During active browsing session)
  useEffect(() => {
    if (!isCsAdmin || !user?.id) return;

    const channel = supabase
      .channel(`crisp-incoming-notifier-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crisp_messages" },
        async (payload) => {
          const newMsg = payload.new as {
            id?: string;
            direction?: string;
            sender_type?: string;
            content?: string;
            conversation_id?: string;
          };
          // An alert needs both a message id and a conversation to resolve, so
          // bail early rather than queuing an alert that cannot be actioned.
          if (!newMsg?.id || !newMsg.conversation_id) return;

          // Only notify on incoming customer messages
          const isCustomer =
            newMsg.direction === "incoming" ||
            newMsg.sender_type === "customer" ||
            newMsg.sender_type === "user";
          if (!isCustomer) return;

          // Ignore masked / redacted free-plan placeholder messages
          if (isCrispMaskedMessage(newMsg.content)) return;

          // Prevent duplicate notification if already seen
          if (seenMsgIdsRef.current.has(newMsg.id)) return;
          seenMsgIdsRef.current.add(newMsg.id);

          // Fetch conversation details (customer name & workspace name)
          let customerName = "Customer";
          let workspaceName = "Crisp";

          try {
            const { data: conv } = await supabase
              .from("crisp_conversations")
              .select("customer_name, crisp_website_id")
              .eq("id", newMsg.conversation_id)
              .maybeSingle();

            if (conv?.customer_name?.trim()) {
              customerName = conv.customer_name.trim();
            }

            if (conv?.crisp_website_id) {
              const { data: ws } = await supabase
                .from("crisp_workspaces")
                .select("workspace_name")
                .eq("crisp_website_id", conv.crisp_website_id)
                .maybeSingle();
              if (ws?.workspace_name?.trim()) {
                workspaceName = ws.workspace_name.trim();
              }
            }
          } catch {
            // Non-fatal if fetch fails
          }

          const messageSnippet =
            newMsg.content && newMsg.content.length > 220
              ? `${newMsg.content.slice(0, 220)}...`
              : newMsg.content || "Sent a message";

          const alertItem: QueuedMessageAlert = {
            id: newMsg.id,
            conversationId: newMsg.conversation_id,
            customerName,
            workspaceName,
            messageSnippet,
            receivedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          };

          // Play chime and push to persistent center queue
          playCrispChime();
          setActiveQueue((prev) => [...prev, alertItem]);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isCsAdmin, user?.id]);

  if (!isCsAdmin || activeQueue.length === 0) {
    return null;
  }

  const currentItem = activeQueue[0];
  const queueLength = activeQueue.length;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-card border border-border/80 shadow-2xl rounded-2xl p-6 text-card-foreground flex flex-col gap-4 animate-in zoom-in-95 duration-200">
        {/* Top Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/40 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-primary/15 text-primary grid place-items-center shrink-0 animate-pulse">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold tracking-tight text-foreground">
                  New Crisp Message
                </h3>
                {queueLength > 1 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary border-primary/30 flex items-center gap-1 font-semibold"
                  >
                    <Layers className="h-3 w-3" />1 of {queueLength}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Received at {currentItem.receivedAt}
              </p>
            </div>
          </div>

          <button
            onClick={handleDismissTop}
            className="text-muted-foreground hover:text-foreground h-7 w-7 rounded-lg hover:bg-muted grid place-items-center transition-colors"
            title="Close this popup"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Workspace & Customer */}
        <div className="flex items-center justify-between gap-2 bg-muted/40 p-2.5 rounded-xl border border-border/30">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              Customer
            </div>
            <div className="text-sm font-semibold text-foreground truncate">
              {currentItem.customerName}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              Workspace
            </div>
            <Badge
              variant="secondary"
              className="text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
            >
              {currentItem.workspaceName}
            </Badge>
          </div>
        </div>

        {/* Message Content */}
        <div className="bg-background/80 p-3.5 rounded-xl border border-border/40 text-[13px] text-foreground leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap">
          &ldquo;{currentItem.messageSnippet}&rdquo;
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between gap-2 pt-1">
          {queueLength > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismissAll}
              className="text-[12px] h-9 text-muted-foreground hover:text-destructive"
            >
              Dismiss All ({queueLength})
            </Button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDismissTop}
              className="text-[12px] h-9"
            >
              {queueLength > 1 ? `Next (${queueLength - 1} left)` : "Dismiss"}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => handleViewChat(currentItem.conversationId)}
              className="text-[12px] h-9 gap-1.5 font-semibold shadow-sm"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View Chat
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
