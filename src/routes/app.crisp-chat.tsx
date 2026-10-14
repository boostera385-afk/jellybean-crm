import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Building2,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronUp,
  Copy,
  Globe,
  Loader2,
  MessageSquare,
  MapPin,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  PanelRightClose,
  PanelRightOpen,
  Info,
  Download,
  ExternalLink,
  FileText,
  Volume2,
  Paperclip,
  Users,
  Radio,
  Flame,
  Clock,
  X,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  addCrispConversationNote,
  addCrispWorkspace,
  deleteCrispConversationNote,
  deleteCrispWorkspace,
  getCrispConversationNotes,
  getCrispWorkspaceWebhookUrl,
  markCrispConversationRead,
  regenerateCrispWebhookSecret,
  sendCrispMessage,
  sendCrispMessageToVisitor,
  syncCrispHistory,
  type CrispVisitor,
} from "@/lib/crisp.functions";
import { useCrispVisitors } from "@/hooks/use-crisp-visitors";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { RoleGate } from "@/components/page";

export const Route = createFileRoute("/app/crisp-chat")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { conversationId?: string; websiteId?: string; visitorSessionId?: string } => ({
    conversationId:
      typeof search.conversationId === "string" && search.conversationId.trim()
        ? search.conversationId.trim()
        : undefined,
    websiteId:
      typeof search.websiteId === "string" && search.websiteId.trim()
        ? search.websiteId.trim()
        : undefined,
    visitorSessionId:
      typeof search.visitorSessionId === "string" && search.visitorSessionId.trim()
        ? search.visitorSessionId.trim()
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Crisp Chat \u00b7 JellyBean" },
      {
        name: "description",
        content: "Manage customer conversations across connected Crisp workspaces.",
      },
      { property: "og:title", content: "Crisp Chat \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Manage customer conversations across connected Crisp workspaces.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CrispChatPage,
});

type ConversationRecord = {
  id: string;
  crisp_session_id: string;
  crisp_website_id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_avatar: string | null;
  status: string | null;
  last_message: string | null;
  last_message_at: string | null;
  last_customer_unread_at: string | null;
  unread_count: number | null;
  metadata: Json | null;
  created_at: string | null;
  updated_at: string | null;
};

/**
 * Attachment content as Crisp sends it. The webhook payload is untyped JSON, so
 * these fields are read through an explicit shape rather than off `object`.
 */
type CrispAttachmentContent = {
  url?: string;
  preview?: string;
  name?: string;
  filename?: string;
  type?: string;
  size?: number;
  duration?: number;
  text?: string;
};

type CrispRawPayload = {
  type?: string;
  content?: string | CrispAttachmentContent;
};

type MessageRecord = {
  id: string;
  conversation_id: string;
  crisp_session_id: string;
  crisp_website_id: string | null;
  crisp_message_id: string | null;
  sender_type: "user" | "customer" | "operator";
  direction: "incoming" | "outgoing";
  content: string;
  message_type: string | null;
  sent_at: string;
  delivery_state?: "sent" | "delivered" | "seen" | string | null;
  raw_payload: CrispRawPayload | null;
};

type WorkspaceRecord = {
  id: string;
  crisp_website_id: string;
  workspace_name: string | null;
  enabled: boolean;
  credential_secret_id: string | null;
  installed_at: string | null;
  last_seen_at: string | null;
  last_synced_at: string | null;
  auto_greet_enabled?: boolean | null;
  auto_greet_message?: string | null;
  auto_greet_delay_seconds?: number | null;
};

type NoteRecord = {
  id: string;
  conversation_id: string;
  created_by: string;
  note: string;
  is_edited: boolean;
  created_at: string;
  author_name?: string;
  can_delete?: boolean;
};

function isCrispMaskedMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  // Remove whitespace and common punctuation symbols
  const stripped = trimmed.replace(/[\s\p{P}\p{S}]/gu, "");
  // Must have at least 3 characters and consist entirely of 'x' or 'X'
  return stripped.length >= 3 && /^x+$/i.test(stripped);
}

export type CrispAttachment = {
  url: string;
  name: string;
  type?: string;
  size?: number;
  isImage: boolean;
  isAudio: boolean;
  isFile: boolean;
};

function getCustomerAttachment(msg: MessageRecord): CrispAttachment | null {
  const isCustomer =
    msg.sender_type === "customer" || msg.sender_type === "user" || msg.direction === "incoming";
  if (!isCustomer) return null;

  const raw = msg.raw_payload;
  const rawContent = raw?.content;
  // Narrowed once here so the object fields stay readable further down.
  const attachmentContent =
    rawContent && typeof rawContent === "object" ? (rawContent as CrispAttachmentContent) : null;
  let url = "";
  let name = "";
  let type = "";
  let size: number | undefined = undefined;

  if (attachmentContent) {
    url = attachmentContent.url || attachmentContent.preview || "";
    name = attachmentContent.name || attachmentContent.filename || "";
    type = attachmentContent.type || "";
    size = typeof attachmentContent.size === "number" ? attachmentContent.size : undefined;
  } else if (
    typeof rawContent === "string" &&
    (rawContent.startsWith("http://") || rawContent.startsWith("https://"))
  ) {
    url = rawContent.trim();
  }

  // Fallback: check if msg.content itself is an attachment URL
  if (
    !url &&
    typeof msg.content === "string" &&
    (msg.content.startsWith("http://") || msg.content.startsWith("https://"))
  ) {
    url = msg.content.trim();
  }

  if (!url) return null;

  const lowerUrl = url.toLowerCase();
  const lowerType = type.toLowerCase();
  const lowerName = name.toLowerCase();
  const msgType = (msg.message_type || raw?.type || "").toLowerCase();

  const isImage =
    msgType === "image" ||
    msgType === "animation" ||
    msgType === "media" ||
    lowerType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(lowerUrl) ||
    /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(lowerName) ||
    lowerUrl.includes("/image/") ||
    lowerUrl.includes("/animation/");

  const isAudio =
    msgType === "audio" ||
    lowerType.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|aac|webm)(\?.*)?$/i.test(lowerUrl) ||
    /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(lowerName);

  const isFile = !isImage && !isAudio;

  if (isAudio) {
    if (typeof attachmentContent?.duration === "number") {
      name = `Voice Message (${Math.round(attachmentContent.duration)}s)`;
    } else {
      name = "Voice Note";
    }
  } else if (!name) {
    try {
      const parsedUrl = new URL(url);
      const pathnameParts = parsedUrl.pathname.split("/");
      name = decodeURIComponent(pathnameParts[pathnameParts.length - 1] || "attachment");
    } catch {
      name = isImage ? "Photo attachment" : "File attachment";
    }
  }

  return {
    url,
    name,
    type,
    size,
    isImage,
    isAudio,
    isFile,
  };
}

function getDisplayableCaption(
  content: string | null | undefined,
  attachment: CrispAttachment | null,
): string | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (["[image]", "[file]", "[attachment]", "[media]", "[audio]"].includes(lower)) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return null;
  }

  // Filter out raw JSON strings (e.g. {"url":"...","type":"audio/webm"})
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return null;
      }
    } catch {
      // Not JSON
    }
  }

  if (attachment) {
    if (trimmed === attachment.name || trimmed === attachment.url) {
      return null;
    }
    if (attachment.url.includes(trimmed)) {
      return null;
    }
  }

  return trimmed;
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMessageDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const datePart = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${datePart} • ${timePart}`;
}

function formatConversationTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function getWorkspaceDisplayName(websiteId: string, workspacesMap: Map<string, string>): string {
  if (workspacesMap.has(websiteId) && workspacesMap.get(websiteId)?.trim()) {
    return workspacesMap.get(websiteId)!;
  }
  const suffix = websiteId.length > 6 ? websiteId.slice(-5) : websiteId;
  return `Workspace • ${suffix}`;
}

function getVisitorDisplayName(visitor: CrispVisitor) {
  return visitor.nickname?.trim() || visitor.email?.trim() || "Anonymous visitor";
}

function getVisitorLocation(visitor: CrispVisitor) {
  return (
    [visitor.city, visitor.region, visitor.country].filter(Boolean).join(", ") || "Unknown location"
  );
}

function getVisitorBrowser(userAgent: string | null) {
  if (!userAgent) return "Unknown browser";
  if (/edg/i.test(userAgent)) return "Microsoft Edge";
  if (/chrome|crios/i.test(userAgent)) return "Chrome";
  if (/firefox|fxios/i.test(userAgent)) return "Firefox";
  if (/safari/i.test(userAgent)) return "Safari";
  return "Web browser";
}

function getInitials(value: string) {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "V"
  );
}

function MessageDeliveryStatus({ state }: { state?: string | null }) {
  const normalized = state === "delivered" || state === "seen" ? state : "sent";
  if (normalized === "seen") {
    return (
      <span className="flex items-center gap-0.5 text-[10px] font-medium text-sky-500" title="Seen">
        <CheckCheck className="h-3 w-3" />
        Seen
      </span>
    );
  }
  if (normalized === "delivered") {
    return (
      <span
        className="flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground"
        title="Delivered"
      >
        <CheckCheck className="h-3 w-3" />
        Delivered
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground"
      title="Sent"
    >
      <Check className="h-3 w-3" />
      Sent
    </span>
  );
}

function SidebarVisitorCard({
  visitor,
  tone,
  workspaceName,
  onSend,
}: {
  visitor: CrispVisitor;
  tone: "hot" | "warm";
  workspaceName: string;
  onSend: () => void;
}) {
  const location = getVisitorLocation(visitor);
  const page = visitor.last_page_title || visitor.last_page_url || "";
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border px-3.5 py-3.5 transition-colors",
        tone === "hot" ? "border-orange-500/30 bg-orange-500/5" : "border-sky-500/30 bg-sky-500/5",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-1 h-2 w-2 shrink-0 rounded-full",
            visitor.is_online ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span
              className="min-w-0 truncate text-sm font-semibold"
              title={getVisitorDisplayName(visitor)}
            >
              {getVisitorDisplayName(visitor)}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {new Date(visitor.last_seen_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <p
            className="mt-1.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground"
            title={[workspaceName, location].filter(Boolean).join(" · ")}
          >
            {[workspaceName, location].filter(Boolean).join(" · ")}
          </p>
          {page && (
            <p
              className="mt-1.5 line-clamp-2 break-words text-xs leading-relaxed text-foreground/70"
              title={page}
            >
              {page}
            </p>
          )}
          <Button
            size="sm"
            variant={tone === "hot" ? "default" : "outline"}
            className="mt-3 h-8 w-full gap-1.5 text-xs font-semibold"
            onClick={onSend}
          >
            <Send className="h-3 w-3 shrink-0" />
            <span className="truncate">{tone === "hot" ? "Message" : "Follow up"}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function CrispChatPage() {
  const auth = useAuth();
  return (
    <div className="h-full w-full min-h-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[76px] shrink-0 items-center border-b border-border bg-card/30 px-4 backdrop-blur-xl md:px-6">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold tracking-[-0.025em] md:text-2xl">
            Crisp Chat Inbox
          </h1>
          <p className="mt-0.5 truncate text-xs text-muted-foreground md:text-sm">
            Unified multi-workspace customer support portal.
          </p>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col p-3 md:p-4">
        <RoleGate allow={["admin", "cs_admin", "cs"]} current={auth.primaryRole}>
          <CrispInboxInner />
        </RoleGate>
      </div>
    </div>
  );
}

const PAGE_SIZE_CONVS = 30;
const PAGE_SIZE_MSGS = 40;

function CrispInboxInner() {
  const auth = useAuth();
  const { conversationId: deepLinkConversationId, websiteId, visitorSessionId } = Route.useSearch();
  const isAdmin = auth.primaryRole === "admin";
  const canUseCrisp =
    auth.primaryRole === "admin" ||
    auth.primaryRole === "cs_admin" ||
    auth.primaryRole === "cs" ||
    auth.roles.includes("admin") ||
    auth.roles.includes("cs_admin") ||
    auth.roles.includes("cs");
  const visitorOverview = useCrispVisitors(canUseCrisp);

  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspaceSearch, setWorkspaceSearch] = useState<string>("");
  const [workspaceUnrepliedChatsMap, setWorkspaceUnrepliedChatsMap] = useState<Map<string, number>>(
    new Map(),
  );
  const [workspaceHasUnreadMap, setWorkspaceHasUnreadMap] = useState<Map<string, boolean>>(
    new Map(),
  );
  const [workspaceLatestUnreadAtMap, setWorkspaceLatestUnreadAtMap] = useState<Map<string, string>>(
    new Map(),
  );
  const [totalUnrepliedCount, setTotalUnrepliedCount] = useState<number>(0);
  const [hasAnyUnread, setHasAnyUnread] = useState<boolean>(false);
  const [visitorDialogOpen, setVisitorDialogOpen] = useState(false);
  const [visitorView, setVisitorView] = useState<"live" | "today">("live");
  const [selectedVisitor, setSelectedVisitor] = useState<CrispVisitor | null>(null);
  const [visitorMessage, setVisitorMessage] = useState("");
  const [isMessagingVisitor, setIsMessagingVisitor] = useState(false);

  const [selectedWebsiteId, setSelectedWebsiteId] = useState<string>("all");
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);

  // Pagination states for Conversation list
  const [convPage, setConvPage] = useState<number>(0);
  const [hasMoreConvs, setHasMoreConvs] = useState<boolean>(true);
  const [isLoadingConvs, setIsLoadingConvs] = useState<boolean>(false);
  const [initialConversationsLoaded, setInitialConversationsLoaded] = useState(false);

  // Pagination states for Messages thread
  const [hasMoreMessages, setHasMoreMessages] = useState<boolean>(false);
  const [isLoadingOlderMsgs, setIsLoadingOlderMsgs] = useState<boolean>(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [noteInput, setNoteInput] = useState("");

  const [isSending, setIsSending] = useState(false);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [isMarkingRead, setIsMarkingRead] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isHoveringSync, setIsHoveringSync] = useState(false);
  const abortSyncRef = useRef(false);
  const [showRightPanel, setShowRightPanel] = useState(true);

  // Admin Workspace Management Modals State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addWebsiteId, setAddWebsiteId] = useState("");
  const [addTokenId, setAddTokenId] = useState("");
  const [addTokenKey, setAddTokenKey] = useState("");
  const [isAddingWorkspace, setIsAddingWorkspace] = useState(false);
  const [addSuccessResult, setAddSuccessResult] = useState<{
    workspaceName: string;
    webhookUrl: string;
  } | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // View Webhook Modal
  const [viewWebhookWs, setViewWebhookWs] = useState<WorkspaceRecord | null>(null);
  const [viewWebhookUrl, setViewWebhookUrl] = useState<string | null>(null);
  const [isFetchingWebhook, setIsFetchingWebhook] = useState(false);

  // Regenerate Webhook Dialog
  const [regenWebhookWs, setRegenWebhookWs] = useState<WorkspaceRecord | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenResultUrl, setRegenResultUrl] = useState<string | null>(null);

  // Delete Workspace Dialog
  const [deleteWs, setDeleteWs] = useState<WorkspaceRecord | null>(null);
  const [isDeletingWs, setIsDeletingWs] = useState(false);

  // Refs for message container, conversation scroll container, and stable realtime access
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const convScrollRef = useRef<HTMLDivElement>(null);
  const selectedConversationIdRef = useRef(selectedConversationId);
  const selectedWebsiteIdRef = useRef(selectedWebsiteId);
  const workspacesRef = useRef(workspaces);
  const handledConversationLinkRef = useRef<string | null>(null);
  const handledVisitorLinkRef = useRef<string | null>(null);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    selectedWebsiteIdRef.current = selectedWebsiteId;
  }, [selectedWebsiteId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    if (
      !initialConversationsLoaded ||
      !deepLinkConversationId ||
      handledConversationLinkRef.current === deepLinkConversationId
    ) {
      return;
    }
    handledConversationLinkRef.current = deepLinkConversationId;

    let cancelled = false;
    void supabase
      .from("crisp_conversations")
      .select("*")
      .eq("id", deepLinkConversationId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          toast.error("Could not open this Crisp conversation");
          return;
        }

        const conversation = data as ConversationRecord;
        setConversations((current) => {
          const exists = current.some((item) => item.id === conversation.id);
          return exists
            ? current.map((item) => (item.id === conversation.id ? conversation : item))
            : [conversation, ...current];
        });
        setSelectedConversationId(conversation.id);
      });

    return () => {
      cancelled = true;
    };
  }, [deepLinkConversationId, initialConversationsLoaded]);

  useEffect(() => {
    if (!websiteId || !visitorSessionId || !visitorOverview.data?.fetchedAt) return;

    const visitorKey = `${websiteId}:${visitorSessionId}`;
    if (handledVisitorLinkRef.current === visitorKey) return;

    const visitors = [
      ...(visitorOverview.data.liveVisitors ?? []),
      ...(visitorOverview.data.todayVisitors ?? []),
    ];
    const visitor = visitors.find(
      (item) => item.crisp_website_id === websiteId && item.crisp_session_id === visitorSessionId,
    );
    if (!visitor) return;

    handledVisitorLinkRef.current = visitorKey;
    setSelectedWebsiteId(visitor.crisp_website_id);
    setVisitorView(visitor.is_online ? "live" : "today");
    setSelectedVisitor(visitor);
    setVisitorMessage("");
    setVisitorDialogOpen(true);
  }, [visitorOverview.data, visitorSessionId, websiteId]);

  // Load active enabled registered workspaces.
  // Returns the fetched rows AND immediately updates workspacesRef.current so that
  // callers can pass the returned ids into loadConversations without waiting for
  // a React state re-render (fixes the "no conversations on initial All Workspaces load" race).
  const loadWorkspaces = async (): Promise<WorkspaceRecord[]> => {
    const { data } = await supabase
      .from("crisp_workspaces")
      .select("*")
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    const rows = (data as WorkspaceRecord[] | null) ?? [];
    workspacesRef.current = rows; // update ref immediately before React re-render
    setWorkspaces(rows);
    return rows;
  };

  // Load aggregate workspace stats using efficient RPC (ENABLED workspaces only)
  // Number shown beside each workspace is: NUMBER OF CHATS CURRENTLY NEEDING A REPLY
  const loadWorkspaceCounts = async () => {
    const { data, error } = await supabase.rpc("get_crisp_workspace_summaries");

    if (!error && data) {
      const unrepliedMap = new Map<string, number>();
      const hasUnreadMap = new Map<string, boolean>();
      const latestUnreadMap = new Map<string, string>();
      let grandUnrepliedTotal = 0;
      let anyUnread = false;

      data.forEach((item) => {
        const wsId = item.crisp_website_id;
        const unreplied = Number(item.unreplied_chat_count ?? item.total_chat_count ?? 0);
        const unread = Boolean(item.has_unread || unreplied > 0);
        const latestTime = item.latest_unread_at ? String(item.latest_unread_at) : "";

        unrepliedMap.set(wsId, unreplied);
        hasUnreadMap.set(wsId, unread);
        if (latestTime) latestUnreadMap.set(wsId, latestTime);

        grandUnrepliedTotal += unreplied;
        if (unread) anyUnread = true;
      });

      setWorkspaceUnrepliedChatsMap(unrepliedMap);
      setWorkspaceHasUnreadMap(hasUnreadMap);
      setWorkspaceLatestUnreadAtMap(latestUnreadMap);
      setTotalUnrepliedCount(grandUnrepliedTotal);
      setHasAnyUnread(anyUnread);
    }
  };

  // Fetch conversations page using the get_crisp_conversations_page RPC.
  //
  // KEY DESIGN DECISIONS:
  //   1. Ordering is done globally by the DB (unread_count > 0 DESC, last_message_at DESC).
  //      React-side sort is only a display fallback; it must NOT override the server order.
  //   2. When searchQuery is present, the search runs server-side across ALL conversations
  //      in the active workspace(s) — not just the currently loaded page.
  //   3. activeWebsiteIdsOverride lets the initial mount pass freshly-fetched IDs
  //      without waiting for a React state update (fixes the race condition).
  const loadConversations = async (
    targetWebsiteId?: string,
    isReset = true,
    activeWebsiteIdsOverride?: string[],
    searchOverride?: string,
  ) => {
    const wsId = targetWebsiteId !== undefined ? targetWebsiteId : selectedWebsiteIdRef.current;
    const pageToLoad = isReset ? 0 : convPage + 1;
    setIsLoadingConvs(true);

    // Use override (initial load) or ref (subsequent calls)
    const activeWebsiteIds =
      activeWebsiteIdsOverride ?? workspacesRef.current.map((w) => w.crisp_website_id);
    if (activeWebsiteIds.length === 0) {
      setConversations([]);
      setHasMoreConvs(false);
      setIsLoadingConvs(false);
      return;
    }

    const targetIds = wsId !== "all" ? [wsId] : activeWebsiteIds;
    const search = searchOverride !== undefined ? searchOverride : searchQuery;

    const { data, error } = await supabase.rpc("get_crisp_conversations_page", {
      p_website_ids: targetIds,
      p_limit: PAGE_SIZE_CONVS,
      p_offset: pageToLoad * PAGE_SIZE_CONVS,
      p_search: search.trim() || undefined,
    });

    setIsLoadingConvs(false);

    if (!error && data) {
      if (isReset) {
        setConversations(data);
        setConvPage(0);
      } else {
        setConversations((prev) => [...prev, ...data]);
        setConvPage(pageToLoad);
      }
      setHasMoreConvs(data.length === PAGE_SIZE_CONVS);
    }
  };

  // Handle infinite scrolling in Column 2 conversation list
  const handleConvScroll = () => {
    const el = convScrollRef.current;
    if (!el || isLoadingConvs || !hasMoreConvs) return;

    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 100) {
      loadConversations(selectedWebsiteId, false);
    }
  };

  // Fetch initial messages batch for active conversation (Newest 40 messages)
  const loadMessages = async (convId: string, shouldScrollBottom = false) => {
    const { data } = await supabase
      .from("crisp_messages")
      .select("*")
      .eq("conversation_id", convId)
      .order("sent_at", { ascending: false })
      .limit(PAGE_SIZE_MSGS);

    if (data) {
      const sortedAsc = (data as MessageRecord[]).reverse();
      setMessages(sortedAsc);
      setHasMoreMessages(data.length === PAGE_SIZE_MSGS);

      if (shouldScrollBottom) {
        setTimeout(() => scrollToBottom("auto"), 50);
      }
    }
  };

  // Load older messages for message pagination
  const loadOlderMessages = async () => {
    if (!selectedConversationId || messages.length === 0 || isLoadingOlderMsgs) return;
    setIsLoadingOlderMsgs(true);

    const oldestSentAt = messages[0].sent_at;
    const { data } = await supabase
      .from("crisp_messages")
      .select("*")
      .eq("conversation_id", selectedConversationId)
      .lt("sent_at", oldestSentAt)
      .order("sent_at", { ascending: false })
      .limit(PAGE_SIZE_MSGS);

    setIsLoadingOlderMsgs(false);

    if (data && data.length > 0) {
      const olderSorted = (data as MessageRecord[]).reverse();
      const container = messagesContainerRef.current;
      const oldScrollHeight = container?.scrollHeight || 0;

      setMessages((prev) => [...olderSorted, ...prev]);
      setHasMoreMessages(data.length === PAGE_SIZE_MSGS);

      // Preserve scroll position relative to top
      setTimeout(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - oldScrollHeight;
        }
      }, 30);
    } else {
      setHasMoreMessages(false);
    }
  };

  // Fetch internal notes for active conversation
  const loadNotes = async (convId: string) => {
    try {
      const res = await getCrispConversationNotes({ data: { conversationId: convId } });
      if (res.ok && res.notes) {
        setNotes(res.notes);
      }
    } catch (err: unknown) {
      console.error("Failed to load notes:", err);
    }
  };

  // Scroll message thread container to bottom without moving outer page
  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior,
      });
    }
  };

  // Check if message viewport is near bottom
  const isNearBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 120;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
  };

  // Initial load
  useEffect(() => {
    void loadWorkspaces().then(async (fetchedWorkspaces) => {
      const activeIds = fetchedWorkspaces.map((w) => w.crisp_website_id);
      void loadWorkspaceCounts();
      // Pass freshly-fetched IDs directly — avoids race where workspacesRef.current
      // has not yet been populated when loadConversations reads it.
      await loadConversations("all", true, activeIds);
      setInitialConversationsLoaded(true);
    });
    // Mount-once by design. `loadWorkspaces` / `loadConversations` are plain
    // functions (new identity every render), so listing them would re-run this
    // on every render. Fresh values are read through refs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run server-side search whenever searchQuery changes
  useEffect(() => {
    loadConversations(selectedWebsiteId, true, undefined, searchQuery);
    // `selectedWebsiteId` is read at call time on purpose: this effect exists to
    // re-run the server-side search when `searchQuery` changes, not when the
    // workspace filter changes (a separate effect below owns that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Reload conversations when selected workspace filter changes
  useEffect(() => {
    loadConversations(selectedWebsiteId, true);

    // Clear active conversation if it does not belong to newly selected workspace
    if (selectedWebsiteId !== "all" && selectedConversationId) {
      const activeConv = conversations.find((c) => c.id === selectedConversationId);
      if (activeConv && activeConv.crisp_website_id !== selectedWebsiteId) {
        setSelectedConversationId(null);
        setMessages([]);
        setNotes([]);
      }
    }
    // `conversations` is deliberately omitted: reading it here would make this
    // effect depend on the list it mutates via `loadConversations`, which
    // re-fetches and can loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWebsiteId]);

  // Load messages & notes when active conversation selection changes
  useEffect(() => {
    if (selectedConversationId) {
      loadMessages(selectedConversationId, true);
      loadNotes(selectedConversationId);
    } else {
      setMessages([]);
      setNotes([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversationId]);

  // Handle selecting a conversation
  // IMPORTANT: Opening/viewing a chat must NOT clear the unread/needs-reply state.
  // Only sending an operator reply after the customer's message clears it.
  const handleSelectConversation = (convId: string) => {
    setSelectedConversationId(convId);
  };

  // Stable Realtime Subscriptions (Single channel created ONCE on mount)
  useEffect(() => {
    const channel = supabase
      .channel("crisp_inbox_realtime_stable")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisp_conversations" },
        (payload) => {
          // ── Preserve loaded pages ──────────────────────────────────────────
          // Do NOT reset the conversation list to page 1 on every update.
          // Instead, surgically update or insert the affected row in our
          // existing conversations array. This preserves infinite-scroll state
          // and scroll position.
          //
          // For INSERT events we prepend/re-sort locally; for UPDATE we patch
          // in place. For DELETE we remove. Counts are always refreshed.
          loadWorkspaceCounts();

          const changedRow = (payload.new ?? payload.old) as ConversationRecord | undefined;
          if (!changedRow?.id) {
            // Fallback: no row data — full reload (should be rare)
            loadConversations(selectedWebsiteIdRef.current, true);
            return;
          }

          if (payload.eventType === "DELETE") {
            setConversations((prev) => prev.filter((c) => c.id !== changedRow.id));
            return;
          }

          // UPDATE or INSERT
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === changedRow.id);
            if (idx !== -1) {
              // Patch existing row
              const updated = [...prev];
              updated[idx] = { ...updated[idx], ...changedRow };
              // Re-sort: unread first, then last_message_at DESC (masked messages never unread)
              updated.sort((a, b) => {
                const ua =
                  (a.unread_count || 0) > 0 && !isCrispMaskedMessage(a.last_message) ? 1 : 0;
                const ub =
                  (b.unread_count || 0) > 0 && !isCrispMaskedMessage(b.last_message) ? 1 : 0;
                if (ua !== ub) return ub - ua;
                return (b.last_message_at || "").localeCompare(a.last_message_at || "");
              });
              return updated;
            } else {
              // New row — only include if it belongs to the active view
              const activeIds = workspacesRef.current.map((w) => w.crisp_website_id);
              const activeView = selectedWebsiteIdRef.current;
              const belongsHere =
                activeView === "all"
                  ? activeIds.includes(changedRow.crisp_website_id)
                  : changedRow.crisp_website_id === activeView;
              if (!belongsHere) return prev;
              const updated = [changedRow, ...prev];
              updated.sort((a, b) => {
                const ua =
                  (a.unread_count || 0) > 0 && !isCrispMaskedMessage(a.last_message) ? 1 : 0;
                const ub =
                  (b.unread_count || 0) > 0 && !isCrispMaskedMessage(b.last_message) ? 1 : 0;
                if (ua !== ub) return ub - ua;
                return (b.last_message_at || "").localeCompare(a.last_message_at || "");
              });
              return updated;
            }
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crisp_messages" },
        (payload) => {
          const activeId = selectedConversationIdRef.current;
          const newMsg = payload.new as MessageRecord;

          if (activeId && newMsg && newMsg.conversation_id === activeId) {
            const nearBottom = isNearBottom();

            // Append new message without discarding loaded older pages
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });

            if (nearBottom) {
              setTimeout(() => scrollToBottom("smooth"), 30);
            }
          }

          // Keep the Hot / Awaiting-reply buckets accurate without re-querying:
          // a customer reply moves the visitor to "replied" (drops out of both
          // rails), an operator message moves them to "warm" (awaiting reply).
          if (newMsg?.crisp_website_id && newMsg?.crisp_session_id) {
            const msgKey = `${newMsg.crisp_website_id}:${newMsg.crisp_session_id}`;
            if (liveSessionKeysRef.current.has(msgKey)) {
              const isOut = newMsg.direction === "outgoing" || newMsg.sender_type === "operator";
              setVisitorMsgState((prev) => {
                const nextState = isOut ? "warm" : "replied";
                if (prev.get(msgKey) === nextState) return prev;
                const next = new Map(prev);
                next.set(msgKey, nextState);
                return next;
              });
            }
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "crisp_messages" },
        (payload) => {
          const activeId = selectedConversationIdRef.current;
          const updated = payload.new as MessageRecord;
          if (!activeId || !updated || updated.conversation_id !== activeId) return;
          // Keep delivery-state ticks (sent -> delivered -> seen) in sync live.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === updated.id ? { ...m, delivery_state: updated.delivery_state } : m,
            ),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisp_conversation_notes" },
        () => {
          const activeId = selectedConversationIdRef.current;
          if (activeId) {
            loadNotes(activeId);
          }
        },
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "crisp_workspaces" }, () => {
        loadWorkspaces();
      })
      .subscribe();

    // ── Background Auto-Sync Heartbeat (Every 30s) ──────────────────────────
    // Automatically refreshes conversations, workspace counts, and active chat
    // so new messages always appear without requiring manual sync clicks.
    const pollInterval = setInterval(() => {
      loadWorkspaceCounts();
      loadConversations(selectedWebsiteIdRef.current, true);
      const activeId = selectedConversationIdRef.current;
      if (activeId) {
        loadMessages(activeId);
      }
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadWorkspaceCounts();
        loadConversations(selectedWebsiteIdRef.current, true);
        const activeId = selectedConversationIdRef.current;
        if (activeId) {
          loadMessages(activeId);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      supabase.removeChannel(channel);
    };
    // Mount-once by design. `loadMessages` reads the active conversation through
    // `selectedConversationIdRef`, so it does not need to be a dependency; adding
    // it (new identity every render) would tear down and rebuild the realtime
    // channel and polling interval on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Map of workspace website_id -> workspace_name
  const workspacesMap = useMemo(() => {
    const map = new Map<string, string>();
    workspaces.forEach((w) => {
      if (w.workspace_name) {
        map.set(w.crisp_website_id, w.workspace_name);
      }
    });
    return map;
  }, [workspaces]);

  const liveVisitors = useMemo(
    () =>
      (visitorOverview.data?.liveVisitors ?? []).filter(
        (visitor) => selectedWebsiteId === "all" || visitor.crisp_website_id === selectedWebsiteId,
      ),
    [selectedWebsiteId, visitorOverview.data?.liveVisitors],
  );
  const todayVisitors = useMemo(
    () =>
      (visitorOverview.data?.todayVisitors ?? []).filter(
        (visitor) => selectedWebsiteId === "all" || visitor.crisp_website_id === selectedWebsiteId,
      ),
    [selectedWebsiteId, visitorOverview.data?.todayVisitors],
  );
  const liveVisitorCount =
    selectedWebsiteId === "all"
      ? (visitorOverview.data?.liveCount ?? liveVisitors.length)
      : liveVisitors.length;
  const todayVisitorCount = todayVisitors.length;
  const activeLiveVisitors =
    selectedWebsiteId === "all"
      ? (visitorOverview.data?.activeCount ??
        liveVisitors.filter((visitor) => visitor.active).length)
      : liveVisitors.filter((visitor) => visitor.active).length;

  // Classify each live visitor by what has happened in their conversation so we
  // can split the right rail into a "Hot Section" (nobody has reached out yet)
  // and an "awaiting reply" section (we sent the first message, no answer yet).
  // Visitors who have replied drop out of both — they live in the inbox list.
  const allLiveVisitors = useMemo(
    () => visitorOverview.data?.liveVisitors ?? [],
    [visitorOverview.data?.liveVisitors],
  );
  // Stable fingerprint of the live-visitor SET (ignores per-poll object churn).
  // The classification query below keys off this, so it only re-queries when a
  // visitor actually joins or leaves — not on every 4s refresh.
  const liveVisitorsKey = useMemo(
    () =>
      allLiveVisitors
        .map((v) => `${v.crisp_website_id}|${v.crisp_session_id}`)
        .sort()
        .join(","),
    [allLiveVisitors],
  );
  const [visitorMsgState, setVisitorMsgState] = useState<Map<string, "hot" | "warm" | "replied">>(
    new Map(),
  );

  // Classify each live visitor (hot / warm / replied) with ONE query per
  // set-change. Between changes the realtime crisp_messages subscription patches
  // individual visitors as messages flow, so a 4s poll never re-reads the DB.
  useEffect(() => {
    const entries = liveVisitorsKey ? liveVisitorsKey.split(",") : [];
    if (!canUseCrisp || entries.length === 0) {
      setVisitorMsgState(new Map());
      return;
    }
    const pairs = entries.map((entry) => {
      const sep = entry.indexOf("|");
      return { websiteId: entry.slice(0, sep), sessionId: entry.slice(sep + 1) };
    });
    const websiteIds = Array.from(new Set(pairs.map((p) => p.websiteId)));
    const sessionIds = Array.from(new Set(pairs.map((p) => p.sessionId)));
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("crisp_messages")
        .select("crisp_website_id, crisp_session_id, direction, sender_type, sent_at")
        .in("crisp_website_id", websiteIds)
        .in("crisp_session_id", sessionIds);
      if (cancelled) return;
      type MsgAgg = { hasOutgoing: boolean; lastDir: "out" | "in"; lastAt: string };
      const byKey = new Map<string, MsgAgg>();
      (data ?? []).forEach((m) => {
        const key = `${m.crisp_website_id}:${m.crisp_session_id}`;
        const isOut = m.direction === "outgoing" || m.sender_type === "operator";
        const cur = byKey.get(key) ?? { hasOutgoing: false, lastDir: "in" as const, lastAt: "" };
        if (isOut) cur.hasOutgoing = true;
        const at = m.sent_at ?? "";
        if (!cur.lastAt || at > cur.lastAt) {
          cur.lastAt = at;
          cur.lastDir = isOut ? "out" : "in";
        }
        byKey.set(key, cur);
      });
      const next = new Map<string, "hot" | "warm" | "replied">();
      pairs.forEach(({ websiteId, sessionId }) => {
        const key = `${websiteId}:${sessionId}`;
        const info = byKey.get(key);
        if (!info || !info.hasOutgoing) next.set(key, "hot");
        else if (info.lastDir === "out") next.set(key, "warm");
        else next.set(key, "replied");
      });
      setVisitorMsgState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [canUseCrisp, liveVisitorsKey]);

  const sortVisitorsNewestFirst = (list: CrispVisitor[]) =>
    [...list].sort((a, b) => {
      const aKey = a.first_seen_at || a.last_seen_at || "";
      const bKey = b.first_seen_at || b.last_seen_at || "";
      return bKey.localeCompare(aKey);
    });
  const hotVisitors = useMemo(
    () =>
      sortVisitorsNewestFirst(
        liveVisitors.filter(
          (v) =>
            (visitorMsgState.get(`${v.crisp_website_id}:${v.crisp_session_id}`) ?? "hot") === "hot",
        ),
      ),
    [liveVisitors, visitorMsgState],
  );
  const warmVisitors = useMemo(
    () =>
      sortVisitorsNewestFirst(
        liveVisitors.filter(
          (v) => visitorMsgState.get(`${v.crisp_website_id}:${v.crisp_session_id}`) === "warm",
        ),
      ),
    [liveVisitors, visitorMsgState],
  );

  // Session keys of everyone currently live, so the inbox can flag a
  // conversation whose visitor is browsing right now (e.g. a warm visitor who
  // just replied drops out of "Awaiting reply" and lights up here instead).
  const liveSessionKeys = useMemo(
    () => new Set(allLiveVisitors.map((v) => `${v.crisp_website_id}:${v.crisp_session_id}`)),
    [allLiveVisitors],
  );
  // Expose the current live-session set to the realtime handler (set up once)
  // so it can reclassify a visitor the instant a message arrives.
  const liveSessionKeysRef = useRef(liveSessionKeys);
  useEffect(() => {
    liveSessionKeysRef.current = liveSessionKeys;
  }, [liveSessionKeys]);

  // Sorted Workspaces Priority:
  // 1. All Workspaces stays pinned first
  // 2. Workspaces with at least one chat needing reply (> 0) come first (sorted by unread/needs-reply CHAT COUNT DESC)
  // 3. Workspaces with zero unread chats (=== 0) come after all unread workspaces
  // 4. Stable tie-breaker: Workspace name ASC (alphabetical)
  const sortedWorkspaces = useMemo(() => {
    return [...workspaces].sort((a, b) => {
      const countA = workspaceUnrepliedChatsMap.get(a.crisp_website_id) || 0;
      const countB = workspaceUnrepliedChatsMap.get(b.crisp_website_id) || 0;

      // 1. Workspaces with unread/needs-reply chats (> 0) come before zero-unread workspaces (=== 0)
      const hasA = countA > 0;
      const hasB = countB > 0;
      if (hasA !== hasB) {
        return hasA ? -1 : 1;
      }

      // 2. Among unread workspaces: sort by unread/needs-reply CHAT COUNT DESC
      if (hasA && hasB) {
        if (countA !== countB) {
          return countB - countA;
        }
        // If equal count: sort by latest unread customer activity DESC
        const timeA = workspaceLatestUnreadAtMap.get(a.crisp_website_id) || "";
        const timeB = workspaceLatestUnreadAtMap.get(b.crisp_website_id) || "";
        if (timeA !== timeB) {
          return timeB.localeCompare(timeA);
        }
      }

      // 3. Stable tie-breaker: Workspace name ASC (alphabetical)
      const nameA = getWorkspaceDisplayName(a.crisp_website_id, workspacesMap).toLowerCase();
      const nameB = getWorkspaceDisplayName(b.crisp_website_id, workspacesMap).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [workspaces, workspaceUnrepliedChatsMap, workspaceLatestUnreadAtMap, workspacesMap]);

  const filteredWorkspaces = useMemo(() => {
    if (!workspaceSearch.trim()) return sortedWorkspaces;
    const q = workspaceSearch.toLowerCase().trim();
    return sortedWorkspaces.filter((ws) => {
      const displayName = getWorkspaceDisplayName(ws.crisp_website_id, workspacesMap);
      return (
        displayName.toLowerCase().includes(q) ||
        (ws.workspace_name || "").toLowerCase().includes(q) ||
        ws.crisp_website_id.toLowerCase().includes(q)
      );
    });
  }, [sortedWorkspaces, workspaceSearch, workspacesMap]);

  // Conversations for display — the DB RPC already returns globally ordered results
  // (unread_count > 0 DESC, last_message_at DESC) and server-side search is applied.
  // We preserve that order and only apply local re-sort when realtime patches rows
  // in-place (the realtime handler already re-sorts before calling setConversations).
  // NOTE: Do NOT apply a local search filter here — search is server-side via RPC.
  const filteredConversations = conversations;

  const activeConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedConversationId) || null;
  }, [conversations, selectedConversationId]);

  // Handle Send Message
  // Sending an operator reply clears the unread/needs-reply state for this conversation!
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedConversationId || !messageInput.trim() || isSending) return;

    setIsSending(true);
    const content = messageInput.trim();
    setMessageInput("");

    try {
      const res = await sendCrispMessage({
        data: { conversationId: selectedConversationId, content },
      });
      if (!res.ok) {
        toast.error(res.error || "Could not send message");
        setMessageInput(content);
      } else {
        // Optimistically append message to UI instantly
        setMessages((prev) => {
          const tempMsg: MessageRecord = {
            id: `temp_${Date.now()}`,
            conversation_id: selectedConversationId,
            crisp_website_id: activeConversation?.crisp_website_id || "",
            crisp_session_id: activeConversation?.crisp_session_id || "",
            crisp_message_id: `temp_${Date.now()}`,
            sender_type: "operator",
            direction: "outgoing",
            content: content,
            message_type: "text",
            sent_at: res.sent_at || new Date().toISOString(),
            delivery_state: "sent",
            raw_payload: {},
          };
          return [...prev, tempMsg];
        });

        // Clear needs-reply state locally and reload workspace counts
        setConversations((prev) =>
          prev.map((c) =>
            c.id === selectedConversationId
              ? {
                  ...c,
                  unread_count: 0,
                  last_customer_unread_at: null,
                  last_message: content,
                  last_message_at: res.sent_at || new Date().toISOString(),
                }
              : c,
          ),
        );
        loadWorkspaceCounts();
        scrollToBottom("smooth");
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "An unexpected error occurred");
      setMessageInput(content);
    } finally {
      setIsSending(false);
    }
  };

  const handleMessageVisitor = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedVisitor || !visitorMessage.trim() || isMessagingVisitor) return;

    setIsMessagingVisitor(true);
    try {
      const result = await sendCrispMessageToVisitor({
        data: {
          websiteId: selectedVisitor.crisp_website_id,
          sessionId: selectedVisitor.crisp_session_id,
          content: visitorMessage.trim(),
        },
      });
      if (!result.ok) {
        toast.error(result.error || "Could not message this visitor");
        return;
      }

      toast.success("Message sent to the live visitor");
      setVisitorMessage("");
      setVisitorDialogOpen(false);
      await loadConversations(selectedWebsiteId, true);
      setSelectedConversationId(result.conversationId);
    } catch (error) {
      toast.error((error as Error).message || "Could not message this visitor");
    } finally {
      setIsMessagingVisitor(false);
    }
  };

  const handleMarkAsRead = async () => {
    if (!selectedConversationId || isMarkingRead) return;
    setIsMarkingRead(true);
    try {
      const res = await markCrispConversationRead({
        data: { conversationId: selectedConversationId },
      });
      if (!res.ok) {
        toast.error(res.error || "Could not mark as read");
      } else {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === selectedConversationId
              ? {
                  ...c,
                  unread_count: 0,
                  last_customer_unread_at: null,
                }
              : c,
          ),
        );
        loadWorkspaceCounts();
        toast.success("Chat marked as read");
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "An unexpected error occurred");
    } finally {
      setIsMarkingRead(false);
    }
  };

  // Handle Add Note
  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedConversationId || !noteInput.trim() || isAddingNote) return;

    setIsAddingNote(true);
    const noteText = noteInput.trim();
    setNoteInput("");

    try {
      const res = await addCrispConversationNote({
        data: { conversationId: selectedConversationId, note: noteText },
      });
      if (!res.ok) {
        toast.error(res.error || "Could not save internal note");
        setNoteInput(noteText);
      } else {
        loadNotes(selectedConversationId);
      }
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setIsAddingNote(false);
    }
  };

  // Handle Delete Note
  const handleDeleteNote = async (noteId: string) => {
    try {
      const res = await deleteCrispConversationNote({ data: { noteId } });
      if (res.ok && selectedConversationId) {
        loadNotes(selectedConversationId);
      }
    } catch (err: unknown) {
      toast.error((err as Error).message);
    }
  };

  // Handle Stop/Abort History Sync
  const handleStopSync = () => {
    abortSyncRef.current = true;
    setIsSyncing(false);
    setIsHoveringSync(false);
    toast.info("Sync stopped");
  };

  // Handle History Sync
  const handleSyncHistory = async () => {
    if (isSyncing) return;
    abortSyncRef.current = false;
    setIsSyncing(true);

    try {
      const websiteIdParam = selectedWebsiteId !== "all" ? selectedWebsiteId : undefined;
      const res = await syncCrispHistory({ data: { websiteId: websiteIdParam } });

      if (abortSyncRef.current) return;

      if (res.ok) {
        toast.success(
          `Synced ${res.synced_conversations} conversations & ${res.synced_messages} messages.`,
        );
        loadWorkspaces();
        loadWorkspaceCounts();
        loadConversations(selectedWebsiteId, true);
        if (selectedConversationId) loadMessages(selectedConversationId);
      } else {
        // If full sync returned an error or timeout and we are on "all", fallback to syncing enabled workspaces individually
        if (selectedWebsiteId === "all" && workspacesRef.current.length > 0) {
          const wsList = workspacesRef.current;
          let totalConvs = 0;
          let totalMsgs = 0;
          let successCount = 0;
          let lastError = res.error;

          for (const ws of wsList) {
            if (abortSyncRef.current) break;
            try {
              const indRes = await syncCrispHistory({ data: { websiteId: ws.crisp_website_id } });
              if (abortSyncRef.current) break;

              if (indRes.ok) {
                totalConvs += indRes.synced_conversations || 0;
                totalMsgs += indRes.synced_messages || 0;
                successCount++;
              } else if (indRes.error) {
                lastError = indRes.error;
              }
            } catch (wsErr: unknown) {
              if (abortSyncRef.current) break;
              lastError = (wsErr as Error).message || lastError;
            }
          }

          if (abortSyncRef.current) return;

          if (successCount > 0) {
            toast.success(
              `Synced ${successCount}/${wsList.length} workspaces (${totalConvs} convs, ${totalMsgs} msgs).`,
            );
            loadWorkspaces();
            loadWorkspaceCounts();
            loadConversations("all", true);
            if (selectedConversationId) loadMessages(selectedConversationId);
          } else {
            toast.error(lastError || "Could not sync history for workspaces");
          }
        } else {
          if (!abortSyncRef.current) {
            toast.error(res.error || "Failed to sync history");
          }
        }
      }
    } catch (err: unknown) {
      if (!abortSyncRef.current) {
        toast.error((err as Error).message || "History sync failed");
      }
    } finally {
      setIsSyncing(false);
      setIsHoveringSync(false);
    }
  };

  // Handle Admin Add Workspace Submit
  const handleAddWorkspaceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addWebsiteId.trim() || !addTokenId.trim() || !addTokenKey.trim() || isAddingWorkspace)
      return;

    setIsAddingWorkspace(true);
    try {
      const res = await addCrispWorkspace({
        data: {
          websiteId: addWebsiteId.trim(),
          tokenId: addTokenId.trim(),
          tokenKey: addTokenKey.trim(),
        },
      });

      if (!res.ok) {
        toast.error(res.error || "Could not add workspace");
      } else {
        setAddSuccessResult({
          workspaceName: res.workspace_name || `Workspace • ${addWebsiteId.slice(0, 5)}`,
          webhookUrl: res.webhook_url || "",
        });
        setAddWebsiteId("");
        setAddTokenId("");
        setAddTokenKey("");
        loadWorkspaces();
        toast.success("Crisp Workspace connected successfully!");
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "An unexpected error occurred");
    } finally {
      setIsAddingWorkspace(false);
    }
  };

  // Handle View Webhook URL (Admin Only, reads existing URL without regenerating)
  const handleOpenViewWebhook = async (ws: WorkspaceRecord) => {
    setViewWebhookWs(ws);
    setViewWebhookUrl(null);
    setIsFetchingWebhook(true);

    try {
      const res = await getCrispWorkspaceWebhookUrl({ data: { websiteId: ws.crisp_website_id } });
      if (!res.ok || !res.webhook_url) {
        toast.error(res.error || "Could not fetch Webhook URL");
      } else {
        setViewWebhookUrl(res.webhook_url);
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "Failed to retrieve Webhook URL");
    } finally {
      setIsFetchingWebhook(false);
    }
  };

  // Handle Regenerate Webhook URL
  const handleConfirmRegenerateWebhook = async () => {
    if (!regenWebhookWs || isRegenerating) return;
    setIsRegenerating(true);

    try {
      const res = await regenerateCrispWebhookSecret({
        data: { websiteId: regenWebhookWs.crisp_website_id },
      });
      if (!res.ok || !res.webhook_url) {
        toast.error(res.error || "Could not regenerate Webhook Secret");
      } else {
        setRegenResultUrl(res.webhook_url);
        toast.success("Webhook URL regenerated successfully!");
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "Failed to regenerate Webhook Secret");
    } finally {
      setIsRegenerating(false);
    }
  };

  // Handle Delete Workspace (Verified Vault secret cleanup before workspace row deletion)
  const handleConfirmDeleteWorkspace = async () => {
    if (!deleteWs || isDeletingWs) return;
    setIsDeletingWs(true);

    try {
      const res = await deleteCrispWorkspace({ data: { websiteId: deleteWs.crisp_website_id } });
      if (!res.ok) {
        toast.error(res.error || "Could not delete workspace");
      } else {
        toast.success(
          `Disconnected workspace "${deleteWs.workspace_name || deleteWs.crisp_website_id}"`,
        );

        if (selectedWebsiteId === deleteWs.crisp_website_id) {
          setSelectedWebsiteId("all");
        }

        setDeleteWs(null);
        loadWorkspaces().then(() => {
          loadWorkspaceCounts();
          loadConversations("all", true);
        });
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "Failed to delete workspace");
    } finally {
      setIsDeletingWs(false);
    }
  };

  const handleCopyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUrl(true);
    toast.success("Copied to clipboard!");
    setTimeout(() => setCopiedUrl(false), 2500);
  };

  return (
    <div className="h-full min-h-0 flex-1 w-full flex flex-col overflow-hidden border border-border rounded-2xl bg-card/35 shadow-[inset_0_1px_0_var(--glass-line),var(--glass-shadow)] backdrop-blur-xl">
      {/* ========================================================================= */}
      {/* WORKSPACES HEADER BAR (horizontal) */}
      {/* ========================================================================= */}
      <div className="w-full shrink-0 border-b border-border/40 bg-card/40 flex items-center gap-2 overflow-hidden px-3 py-2">
        <div className="flex items-center gap-2 shrink-0 font-medium text-xs text-muted-foreground uppercase tracking-wider">
          <Building2 className="w-4 h-4 text-primary shrink-0" />
          <span className="hidden md:inline">Workspaces</span>
        </div>

        {/* Workspace Search Input */}
        <div className="relative shrink-0 w-32 sm:w-40">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={workspaceSearch}
            onChange={(e) => setWorkspaceSearch(e.target.value)}
            className="pl-8 pr-7 h-8 text-xs bg-background/50 border-border/50 focus-visible:ring-1"
          />
          {workspaceSearch && (
            <button
              type="button"
              onClick={() => setWorkspaceSearch("")}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground h-4 w-4 rounded-full grid place-items-center"
              title="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="flex-1 min-w-0 overflow-x-auto overscroll-contain">
          <div className="flex items-center gap-1.5 w-max pr-1">
            {/* All Workspaces (Pinned First) */}
            <button
              onClick={() => setSelectedWebsiteId("all")}
              className={cn(
                "shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors text-left border",
                selectedWebsiteId === "all"
                  ? "bg-primary text-primary-foreground shadow-sm border-primary"
                  : "hover:bg-accent hover:text-accent-foreground text-foreground border-border/50",
              )}
            >
              <Globe className="w-4 h-4 shrink-0" />
              <span className="truncate max-w-[10rem]">All Workspaces</span>
              {hasAnyUnread && (
                <span
                  className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse"
                  title="Has chats needing reply"
                />
              )}
              {totalUnrepliedCount > 0 && (
                <Badge
                  variant={selectedWebsiteId === "all" ? "secondary" : "outline"}
                  className="shrink-0 text-xs px-1.5 py-0 font-semibold border-border/60"
                >
                  {totalUnrepliedCount}
                </Badge>
              )}
            </button>

            <div className="mx-1 h-6 w-px bg-border/40 shrink-0" />

            {/* Individual Active Workspaces List (Filtered & Sorted) */}
            {filteredWorkspaces.length === 0 ? (
              <div className="px-3 text-center text-xs text-muted-foreground whitespace-nowrap">
                No workspaces match &quot;{workspaceSearch}&quot;
              </div>
            ) : (
              filteredWorkspaces.map((ws) => {
                const unrepliedCount = workspaceUnrepliedChatsMap.get(ws.crisp_website_id) || 0;
                const hasUnread = unrepliedCount > 0;
                const displayName = getWorkspaceDisplayName(ws.crisp_website_id, workspacesMap);
                const isSelected = selectedWebsiteId === ws.crisp_website_id;

                return (
                  <div
                    key={ws.crisp_website_id}
                    className={cn(
                      "shrink-0 flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full text-sm transition-colors group border",
                      isSelected
                        ? "bg-primary text-primary-foreground font-medium shadow-sm border-primary"
                        : "hover:bg-accent hover:text-accent-foreground text-muted-foreground border-border/50",
                    )}
                  >
                    <button
                      onClick={() => setSelectedWebsiteId(ws.crisp_website_id)}
                      className="flex items-center gap-2 min-w-0 text-left py-0.5"
                    >
                      <span
                        className={cn(
                          "w-2 h-2 rounded-full shrink-0",
                          ws.enabled ? "bg-emerald-500/60" : "bg-muted",
                        )}
                      />
                      <span className="truncate max-w-[9rem]">{displayName}</span>
                      {hasUnread && (
                        <span
                          className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse ml-0.5"
                          title="Has chats needing reply"
                        />
                      )}
                    </button>

                    <div className="flex items-center gap-1 shrink-0">
                      {unrepliedCount > 0 && (
                        <Badge
                          variant={isSelected ? "secondary" : "outline"}
                          className="text-xs px-1.5 py-0 font-semibold border-border/60"
                        >
                          {unrepliedCount}
                        </Badge>
                      )}

                      {isAdmin && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-md",
                                isSelected
                                  ? "hover:bg-primary-foreground/20 text-primary-foreground"
                                  : "hover:bg-accent text-muted-foreground",
                              )}
                            >
                              <MoreVertical className="w-3.5 h-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48 text-xs">
                            <DropdownMenuItem
                              onClick={() => handleOpenViewWebhook(ws)}
                              className="cursor-pointer"
                            >
                              <Copy className="w-3.5 h-3.5 mr-2 text-primary" />
                              <span>View Webhook URL</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleCopyWebhookUrlFromWs(ws)}
                              className="cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5 mr-2 text-emerald-500" />
                              <span>Copy Webhook URL</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setRegenWebhookWs(ws);
                                setRegenResultUrl(null);
                              }}
                              className="cursor-pointer"
                            >
                              <RefreshCw className="w-3.5 h-3.5 mr-2 text-amber-500" />
                              <span>Regenerate Webhook URL</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeleteWs(ws)}
                              className="cursor-pointer text-destructive focus:text-destructive"
                            >
                              <Trash2 className="w-3.5 h-3.5 mr-2" />
                              <span>Delete Workspace</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 text-xs"
            onClick={() => {
              setAddSuccessResult(null);
              setIsAddModalOpen(true);
            }}
            title="Add Crisp Workspace"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Add</span>
          </Button>
        )}
      </div>

      {/* ========================================================================= */}
      {/* COLUMN ROW: conversations · chat · live visitors + details */}
      {/* ========================================================================= */}
      <div className="flex flex-1 min-h-0 w-full overflow-hidden">
        {/* ========================================================================= */}
        {/* COLUMN 2: CONVERSATIONS LIST (~320px) */}
        {/* ========================================================================= */}
        <div className="w-64 xl:w-72 2xl:w-80 shrink-0 border-r border-border/40 bg-card/20 flex flex-col h-full overflow-hidden">
          {/* Search & Sync Header */}
          <div className="p-3 border-b border-border/40 shrink-0 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
                <Input
                  placeholder="Search chats..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-9 text-xs"
                />
              </div>
              <Button
                variant={isSyncing && isHoveringSync ? "destructive" : "outline"}
                size="icon"
                onClick={isSyncing ? handleStopSync : handleSyncHistory}
                onMouseEnter={() => isSyncing && setIsHoveringSync(true)}
                onMouseLeave={() => setIsHoveringSync(false)}
                title={
                  isSyncing
                    ? isHoveringSync
                      ? "Stop syncing"
                      : "Syncing in progress... (click to stop)"
                    : "Sync Crisp History"
                }
                className={cn(
                  "h-9 w-9 shrink-0 transition-colors duration-150",
                  isSyncing &&
                    isHoveringSync &&
                    "bg-destructive/15 text-destructive border-destructive/40 hover:bg-destructive/25",
                )}
              >
                {isSyncing ? (
                  isHoveringSync ? (
                    <X className="w-4 h-4 text-destructive animate-in fade-in zoom-in-75 duration-150" />
                  ) : (
                    <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                  )
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
              </Button>
            </div>

            <div className="flex items-center gap-2 px-1 pt-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5 text-primary" />
              <span>All messages</span>
            </div>
          </div>

          {/* Conversations Scroll Area with Infinite Scroll */}
          <div
            ref={convScrollRef}
            onScroll={handleConvScroll}
            className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1 overscroll-contain"
          >
            {filteredConversations.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground text-xs">
                {isLoadingConvs ? "Loading conversations..." : "No conversations found."}
              </div>
            ) : (
              <>
                {filteredConversations.map((conv) => {
                  const isSelected = selectedConversationId === conv.id;
                  const isMaskedPreview = isCrispMaskedMessage(conv.last_message);
                  const isUnread = (conv.unread_count || 0) > 0 && !isMaskedPreview;
                  const isLive = liveSessionKeys.has(
                    `${conv.crisp_website_id}:${conv.crisp_session_id}`,
                  );

                  return (
                    <button
                      key={conv.id}
                      onClick={() => handleSelectConversation(conv.id)}
                      className={cn(
                        "w-full text-left p-3 rounded-lg border transition-all space-y-1.5",
                        isSelected
                          ? "bg-accent/80 border-primary/50 shadow-sm"
                          : isLive
                            ? "bg-emerald-500/10 border-emerald-500/40 shadow-xs ring-1 ring-emerald-500/30 hover:bg-emerald-500/15"
                            : isUnread
                              ? "bg-primary/10 border-primary/30 shadow-xs hover:bg-accent/40"
                              : "border-border/20 hover:bg-accent/40",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {isLive ? (
                            <span
                              className="relative flex h-2.5 w-2.5 shrink-0"
                              title="Visitor is live now"
                            >
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                            </span>
                          ) : (
                            isUnread && (
                              <span
                                className="w-2.5 h-2.5 rounded-full bg-primary shrink-0 animate-pulse"
                                title="Needs operator reply"
                              />
                            )
                          )}
                          <span
                            className={cn(
                              "text-sm truncate text-foreground",
                              isUnread || isLive ? "font-bold" : "font-medium",
                            )}
                          >
                            {conv.customer_name || "Visitor"}
                          </span>
                          {isLive && (
                            <Badge
                              variant="outline"
                              className="shrink-0 gap-0.5 border-emerald-500/40 bg-emerald-500/10 px-1 py-0 text-[9px] font-semibold text-emerald-500"
                            >
                              <Radio className="h-2.5 w-2.5" />
                              LIVE
                            </Badge>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0 font-medium">
                          {formatConversationTime(conv.last_message_at)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 text-[10px] font-medium text-emerald-500/90">
                        <Building2 className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {getWorkspaceDisplayName(conv.crisp_website_id, workspacesMap)}
                        </span>
                      </div>

                      <p
                        className={cn(
                          "text-xs line-clamp-2 break-words leading-relaxed",
                          isUnread ? "text-foreground font-medium" : "text-muted-foreground",
                        )}
                      >
                        {isMaskedPreview ? (
                          <span className="italic opacity-75">
                            Message unavailable (Crisp free plan)
                          </span>
                        ) : (
                          conv.last_message || "No messages yet"
                        )}
                      </p>
                    </button>
                  );
                })}

                {isLoadingConvs && (
                  <div className="p-3 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                    <span>Loading more...</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ========================================================================= */}
        {/* COLUMN 3: ACTIVE CHAT THREAD (Flex-1) */}
        {/* ========================================================================= */}
        <div className="flex-1 flex flex-col bg-background min-w-0 h-full overflow-hidden">
          {activeConversation ? (
            <>
              {/* Chat Header (Clean Customer Identity - No Session ID, No Workspace Tag) */}
              <div className="p-3 border-b border-border/40 flex items-center justify-between bg-card/20 shrink-0">
                <div className="flex items-center gap-3 truncate">
                  <Avatar className="w-8 h-8">
                    <AvatarImage src={activeConversation.customer_avatar || undefined} />
                    <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                      {(activeConversation.customer_name || "V")[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="truncate">
                    <div className="flex items-center gap-2 truncate">
                      <h3 className="font-semibold text-sm truncate">
                        {activeConversation.customer_name || "Visitor"}
                      </h3>
                      <Badge
                        variant="outline"
                        className="shrink-0 gap-1 border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-medium text-emerald-500"
                      >
                        <Building2 className="h-3 w-3" />
                        <span className="max-w-[12rem] truncate">
                          {getWorkspaceDisplayName(
                            activeConversation.crisp_website_id,
                            workspacesMap,
                          )}
                        </span>
                      </Badge>
                    </div>
                    {(activeConversation.customer_email || activeConversation.customer_phone) && (
                      <p className="text-xs text-muted-foreground truncate">
                        {activeConversation.customer_email || activeConversation.customer_phone}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {activeConversation.unread_count ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs gap-1.5"
                      onClick={handleMarkAsRead}
                      disabled={isMarkingRead}
                      title="Mark conversation as read without sending a reply"
                    >
                      {isMarkingRead ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                      )}
                      <span>Mark as Read</span>
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground hidden lg:flex"
                    onClick={() => setShowRightPanel((prev) => !prev)}
                    title={showRightPanel ? "Hide visitors & details" : "Show visitors & details"}
                  >
                    {showRightPanel ? (
                      <PanelRightClose className="w-4 h-4" />
                    ) : (
                      <PanelRightOpen className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Messages Scroll Area with Pagination */}
              <div
                ref={messagesContainerRef}
                className="flex-1 min-h-0 overflow-y-auto p-4 overscroll-contain"
              >
                <div className="space-y-3 max-w-3xl mx-auto">
                  {/* Load Older Messages Button */}
                  {hasMoreMessages && (
                    <div className="text-center py-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={loadOlderMessages}
                        disabled={isLoadingOlderMsgs}
                        className="text-xs text-muted-foreground hover:text-foreground h-7 gap-1.5"
                      >
                        {isLoadingOlderMsgs ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <ChevronUp className="w-3.5 h-3.5" />
                        )}
                        <span>Load Older Messages</span>
                      </Button>
                    </div>
                  )}

                  {messages.map((msg) => {
                    const isOperator =
                      msg.sender_type === "operator" || msg.direction === "outgoing";
                    const isMasked = isCrispMaskedMessage(msg.content);
                    const attachment = !isOperator && !isMasked ? getCustomerAttachment(msg) : null;
                    const caption = getDisplayableCaption(msg.content, attachment);

                    return (
                      <div
                        key={msg.id}
                        className={cn(
                          "flex flex-col max-w-[75%]",
                          isOperator ? "ml-auto items-end" : "mr-auto items-start",
                        )}
                      >
                        <div
                          className={cn(
                            "px-3.5 py-2.5 rounded-2xl text-xs break-words shadow-xs space-y-1",
                            isMasked
                              ? "bg-muted/80 border border-border text-foreground rounded-2xl"
                              : isOperator
                                ? "bg-primary text-primary-foreground rounded-br-xs"
                                : "bg-muted text-foreground rounded-bl-xs",
                          )}
                        >
                          {isMasked ? (
                            <div className="flex items-start gap-2 py-0.5 text-foreground">
                              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                              <p className="italic text-xs leading-relaxed text-foreground">
                                Message unavailable — older message history is hidden by the current
                                Crisp plan.
                              </p>
                            </div>
                          ) : attachment?.isImage ? (
                            <div className="space-y-1.5">
                              <a
                                href={attachment.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block group overflow-hidden rounded-xl border border-border/80 bg-background/50 hover:opacity-95 transition-all shadow-xs"
                                title="Click to view full image in a new tab"
                              >
                                <img
                                  src={attachment.url}
                                  alt={attachment.name || "Customer attached photo"}
                                  className="max-h-72 max-w-full rounded-xl object-contain bg-muted/30 group-hover:scale-[1.01] transition-transform duration-150"
                                  loading="lazy"
                                />
                              </a>
                              {caption && (
                                <p className="whitespace-pre-wrap leading-relaxed px-0.5">
                                  {caption}
                                </p>
                              )}
                            </div>
                          ) : attachment?.isAudio ? (
                            <div className="space-y-1.5 py-0.5">
                              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                <Volume2 className="w-3.5 h-3.5 text-primary shrink-0" />
                                <span>{attachment.name}</span>
                              </div>
                              <audio
                                controls
                                className="w-full max-w-[280px] h-8 rounded mt-1"
                                src={attachment.url}
                              >
                                Your browser does not support the audio element.
                              </audio>
                              {caption && (
                                <p className="whitespace-pre-wrap leading-relaxed">{caption}</p>
                              )}
                            </div>
                          ) : attachment?.isFile ? (
                            <div className="space-y-1.5">
                              <a
                                href={attachment.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                download={attachment.name}
                                className="flex items-center gap-2.5 p-2.5 rounded-xl border border-border/80 bg-background/70 hover:bg-accent/40 text-foreground transition-all group shadow-2xs"
                              >
                                <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
                                  <FileText className="w-4 h-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium text-xs truncate group-hover:underline text-foreground">
                                    {attachment.name || "Download Attachment"}
                                  </p>
                                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                                    {attachment.size ? (
                                      <span>{formatFileSize(attachment.size)}</span>
                                    ) : null}
                                    <span className="flex items-center gap-1 text-primary group-hover:underline font-medium">
                                      <Download className="w-3 h-3" /> Download
                                    </span>
                                  </div>
                                </div>
                              </a>
                              {caption && (
                                <p className="whitespace-pre-wrap leading-relaxed">{caption}</p>
                              )}
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                          )}
                        </div>
                        <div
                          className={cn(
                            "flex items-center gap-1.5 px-1 mt-0.5",
                            isOperator ? "flex-row-reverse" : "flex-row",
                          )}
                        >
                          <span className="text-[10px] text-muted-foreground font-medium">
                            {formatMessageDateTime(msg.sent_at)}
                          </span>
                          {isOperator && !isMasked && (
                            <MessageDeliveryStatus state={msg.delivery_state} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Message Composer - Anchored to Bottom */}
              <form
                onSubmit={handleSendMessage}
                className="p-3 border-t border-border/40 flex items-center gap-2 bg-card/20 shrink-0 mt-auto"
              >
                <Textarea
                  placeholder="Type a message to send to Crisp visitor..."
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage(e);
                    }
                  }}
                  className="min-h-[44px] max-h-32 text-xs resize-none flex-1 py-2.5"
                />
                <Button
                  type="submit"
                  disabled={isSending || !messageInput.trim()}
                  className="self-end h-11 px-4 gap-1.5"
                >
                  {isSending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <span>Send</span>
                      <Send className="w-3.5 h-3.5" />
                    </>
                  )}
                </Button>
              </form>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground text-center">
              <MessageSquare className="w-10 h-10 mb-2 stroke-1 opacity-50" />
              <p className="text-sm font-medium">No conversation selected</p>
            </div>
          )}
        </div>

        {/* ========================================================================= */}
        {/* Visitor groups stack until both columns have enough room to stay readable. */}
        {/* ========================================================================= */}
        {showRightPanel && (
          <div className="w-72 xl:w-80 2xl:w-[clamp(36rem,38vw,44rem)] shrink-0 border-l border-border/40 bg-card/30 flex-col 2xl:flex-row h-full overflow-hidden hidden lg:flex">
            {/* HOT SECTION (left column) — live visitors nobody has messaged yet */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col border-b 2xl:border-b-0 2xl:border-r border-border/40">
              <div className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 border-b border-border/40">
                <div className="flex items-center gap-2 min-w-0">
                  <Flame className="h-4 w-4 shrink-0 text-orange-500" />
                  <span className="truncate text-xs font-semibold uppercase tracking-wider text-foreground">
                    Hot Section ({hotVisitors.length})
                  </span>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  onClick={() => visitorOverview.refetch()}
                  disabled={visitorOverview.isFetching}
                  title="Refresh cached visitors (does not call Crisp)"
                >
                  <RefreshCw
                    className={cn("h-3.5 w-3.5", visitorOverview.isFetching && "animate-spin")}
                  />
                </Button>
              </div>
              {visitorOverview.data?.errors?.length ? (
                <div
                  role="status"
                  className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
                >
                  <p className="font-medium">Some visitor data may be delayed</p>
                  <p className="mt-1 break-words">{visitorOverview.data.errors.join(" · ")}</p>
                </div>
              ) : null}
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 overscroll-contain">
                {hotVisitors.length === 0 ? (
                  <div className="flex h-full min-h-24 flex-col items-center justify-center px-4 text-center">
                    <Flame className="mb-2 h-6 w-6 text-muted-foreground/40" />
                    <p className="text-xs text-muted-foreground">
                      No new live visitors to reach out to.
                    </p>
                  </div>
                ) : (
                  hotVisitors.map((visitor) => (
                    <SidebarVisitorCard
                      key={`${visitor.crisp_website_id}:${visitor.crisp_session_id}`}
                      visitor={visitor}
                      tone="hot"
                      workspaceName={
                        visitor.workspace_name ||
                        getWorkspaceDisplayName(visitor.crisp_website_id, workspacesMap)
                      }
                      onSend={() => {
                        setSelectedVisitor(visitor);
                        setVisitorMessage("");
                        setVisitorDialogOpen(true);
                      }}
                    />
                  ))
                )}
              </div>
            </div>

            {/* AWAITING REPLY (right column) — we sent first message, no reply yet */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 border-b border-border/40">
                <div className="flex items-center gap-2 min-w-0">
                  <Clock className="h-4 w-4 shrink-0 text-sky-500" />
                  <span className="truncate text-xs font-semibold uppercase tracking-wider text-foreground">
                    Awaiting reply ({warmVisitors.length})
                  </span>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 overscroll-contain">
                {warmVisitors.length === 0 ? (
                  <div className="flex h-full min-h-24 flex-col items-center justify-center px-4 text-center">
                    <Clock className="mb-2 h-6 w-6 text-muted-foreground/40" />
                    <p className="text-xs text-muted-foreground">
                      No live visitors awaiting a reply.
                    </p>
                  </div>
                ) : (
                  warmVisitors.map((visitor) => (
                    <SidebarVisitorCard
                      key={`${visitor.crisp_website_id}:${visitor.crisp_session_id}`}
                      visitor={visitor}
                      tone="warm"
                      workspaceName={
                        visitor.workspace_name ||
                        getWorkspaceDisplayName(visitor.crisp_website_id, workspacesMap)
                      }
                      onSend={() => {
                        setSelectedVisitor(visitor);
                        setVisitorMessage("");
                        setVisitorDialogOpen(true);
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={visitorDialogOpen}
        onOpenChange={(open) => {
          setVisitorDialogOpen(open);
          if (!open) {
            setVisitorMessage("");
            setSelectedVisitor(null);
          }
        }}
      >
        <DialogContent className="max-h-[86vh] sm:max-w-4xl overflow-hidden p-0">
          <DialogHeader className="border-b border-border/50 px-5 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <Radio className="h-4 w-4 text-emerald-500" /> Website visitors
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs">
                  See who is browsing now, review today&apos;s visitors, and start a Crisp chat.
                </DialogDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => visitorOverview.refetch()}
                disabled={visitorOverview.isFetching}
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", visitorOverview.isFetching && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
          </DialogHeader>

          <div className="border-b border-border/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={visitorView === "live" ? "default" : "outline"}
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  setVisitorView("live");
                  setSelectedVisitor(liveVisitors[0] ?? null);
                }}
              >
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                Live now ({liveVisitorCount})
              </Button>
              <Button
                type="button"
                size="sm"
                variant={visitorView === "today" ? "default" : "outline"}
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  setVisitorView("today");
                  setSelectedVisitor(todayVisitors[0] ?? null);
                }}
              >
                <Users className="h-3.5 w-3.5" />
                Visited today ({todayVisitorCount})
              </Button>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {selectedWebsiteId === "all"
                  ? "All workspaces"
                  : getWorkspaceDisplayName(selectedWebsiteId, workspacesMap)}
              </span>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(300px,0.9fr)]">
            <div className="max-h-[60vh] overflow-y-auto border-r border-border/50 p-3">
              {(visitorView === "live" ? liveVisitors : todayVisitors).length === 0 ? (
                <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
                  <Users className="mb-2 h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium">
                    {visitorView === "live"
                      ? "Nobody is browsing right now"
                      : "No visitors recorded today"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Visitor presence refreshes automatically every 10 seconds.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {(visitorView === "live" ? liveVisitors : todayVisitors).map((visitor) => {
                    const selected =
                      selectedVisitor?.crisp_website_id === visitor.crisp_website_id &&
                      selectedVisitor?.crisp_session_id === visitor.crisp_session_id;
                    return (
                      <button
                        key={`${visitor.crisp_website_id}:${visitor.crisp_session_id}`}
                        type="button"
                        onClick={() => {
                          setSelectedVisitor(visitor);
                          setVisitorMessage("");
                        }}
                        className={cn(
                          "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                          selected
                            ? "border-primary/50 bg-primary/10"
                            : "border-border/50 bg-background/50 hover:bg-accent/40",
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className={cn(
                              "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                              visitor.is_online ? "bg-emerald-500" : "bg-muted-foreground/40",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-semibold">
                                {getVisitorDisplayName(visitor)}
                              </span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {new Date(visitor.last_seen_at).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                              {getVisitorLocation(visitor)}
                            </p>
                            <p className="mt-1 truncate text-[11px] text-foreground/75">
                              {visitor.last_page_title ||
                                visitor.last_page_url ||
                                "Page unavailable"}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-5">
              {selectedVisitor ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <Avatar className="h-11 w-11 border border-border/60">
                      <AvatarImage src={selectedVisitor.avatar || undefined} />
                      <AvatarFallback>
                        {getInitials(getVisitorDisplayName(selectedVisitor))}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold">
                          {getVisitorDisplayName(selectedVisitor)}
                        </h3>
                        <Badge
                          variant="outline"
                          className={cn(
                            "px-1.5 py-0 text-[10px]",
                            selectedVisitor.is_online
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                              : "text-muted-foreground",
                          )}
                        >
                          {selectedVisitor.is_online
                            ? selectedVisitor.active
                              ? "Active now"
                              : "Online"
                            : "Offline"}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {selectedVisitor.workspace_name ||
                          getWorkspaceDisplayName(selectedVisitor.crisp_website_id, workspacesMap)}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg border border-border/50 bg-muted/20 p-2.5">
                      <span className="block text-[10px] font-semibold uppercase text-muted-foreground">
                        Location
                      </span>
                      <span className="mt-1 flex items-center gap-1 font-medium">
                        <MapPin className="h-3 w-3 text-primary" />
                        {getVisitorLocation(selectedVisitor)}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/50 bg-muted/20 p-2.5">
                      <span className="block text-[10px] font-semibold uppercase text-muted-foreground">
                        Browser
                      </span>
                      <span
                        className="mt-1 block font-medium"
                        title={selectedVisitor.user_agent || undefined}
                      >
                        {getVisitorBrowser(selectedVisitor.user_agent)}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/50 bg-muted/20 p-2.5">
                      <span className="block text-[10px] font-semibold uppercase text-muted-foreground">
                        First seen
                      </span>
                      <span className="mt-1 block font-medium">
                        {formatMessageDateTime(selectedVisitor.first_seen_at)}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/50 bg-muted/20 p-2.5">
                      <span className="block text-[10px] font-semibold uppercase text-muted-foreground">
                        Last seen
                      </span>
                      <span className="mt-1 block font-medium">
                        {formatMessageDateTime(selectedVisitor.last_seen_at)}
                      </span>
                    </div>
                  </div>

                  {selectedVisitor.email && (
                    <div className="text-xs">
                      <span className="block text-[10px] font-semibold uppercase text-muted-foreground">
                        Email
                      </span>
                      <span className="break-all font-medium">{selectedVisitor.email}</span>
                    </div>
                  )}

                  {(selectedVisitor.last_page_title || selectedVisitor.last_page_url) && (
                    <div className="text-xs">
                      <span className="block text-[10px] font-semibold uppercase text-muted-foreground">
                        Current page
                      </span>
                      {selectedVisitor.last_page_url ? (
                        <a
                          href={selectedVisitor.last_page_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 flex items-start gap-1 font-medium text-primary hover:underline"
                        >
                          <span className="break-all">
                            {selectedVisitor.last_page_title || selectedVisitor.last_page_url}
                          </span>
                          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="mt-1 block font-medium">
                          {selectedVisitor.last_page_title}
                        </span>
                      )}
                    </div>
                  )}

                  <form
                    onSubmit={handleMessageVisitor}
                    className="space-y-2 border-t border-border/50 pt-4"
                  >
                    <Label htmlFor="visitor-message" className="text-xs font-semibold">
                      Message from JellyBean
                    </Label>
                    <Textarea
                      id="visitor-message"
                      value={visitorMessage}
                      onChange={(event) => setVisitorMessage(event.target.value)}
                      placeholder={
                        selectedVisitor.is_online
                          ? "Type a proactive Crisp message..."
                          : "This visitor is no longer online"
                      }
                      disabled={!selectedVisitor.is_online || isMessagingVisitor}
                      className="min-h-24 resize-none text-xs"
                    />
                    <Button
                      type="submit"
                      className="w-full gap-1.5"
                      disabled={
                        !selectedVisitor.is_online || !visitorMessage.trim() || isMessagingVisitor
                      }
                    >
                      {isMessagingVisitor ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Send through Crisp
                    </Button>
                  </form>
                </div>
              ) : (
                <div className="flex min-h-52 flex-col items-center justify-center text-center text-muted-foreground">
                  <Users className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-xs">Select a visitor to see their details.</p>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ========================================================================= */}
      {/* ADMIN ADD WORKSPACE MODAL */}
      {/* ========================================================================= */}
      {isAdmin && (
        <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                <Building2 className="w-5 h-5 text-primary" />
                <span>Connect Crisp Workspace</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Generate a Website Token in Crisp under{" "}
                <strong>
                  Settings → Workspace Settings → Advanced configuration → REST API / API Token
                </strong>
                .
              </DialogDescription>
            </DialogHeader>

            {!addSuccessResult ? (
              <form onSubmit={handleAddWorkspaceSubmit} className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ws-website-id" className="text-xs font-semibold">
                    Crisp Website ID
                  </Label>
                  <Input
                    id="ws-website-id"
                    placeholder="e.g. 57a2f8b1-39c4-4d8e-90ab-1234567890ab"
                    value={addWebsiteId}
                    onChange={(e) => setAddWebsiteId(e.target.value)}
                    className="text-xs font-mono"
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Found in Crisp under Website Settings → Setup instructions.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ws-token-id" className="text-xs font-semibold">
                    Website Token Identifier (API Identifier)
                  </Label>
                  <Input
                    id="ws-token-id"
                    placeholder="e.g. 59881881-80a1-4328-86d1-..."
                    value={addTokenId}
                    onChange={(e) => setAddTokenId(e.target.value)}
                    className="text-xs font-mono"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ws-token-key" className="text-xs font-semibold">
                    Website Token Key (API Key)
                  </Label>
                  <Input
                    id="ws-token-key"
                    type="text"
                    autoComplete="off"
                    placeholder="e.g. 81a9f012b..."
                    value={addTokenKey}
                    onChange={(e) => setAddTokenKey(e.target.value)}
                    className="text-xs font-mono"
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Credentials are validated with Crisp API and stored encrypted in Supabase Vault.
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-border/40">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsAddModalOpen(false)}
                    disabled={isAddingWorkspace}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={isAddingWorkspace}>
                    {isAddingWorkspace ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                        <span>Validating...</span>
                      </>
                    ) : (
                      <span>Connect Workspace</span>
                    )}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-4 pt-2">
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 space-y-1">
                  <div className="flex items-center gap-2 text-emerald-500 font-semibold text-xs">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Workspace Connected: {addSuccessResult.workspaceName}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Website Token verified successfully and encrypted in Vault.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Website Hook Setup URL</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={addSuccessResult.webhookUrl}
                      className="text-xs font-mono bg-muted/50 select-all"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-9 w-9"
                      onClick={() => handleCopyText(addSuccessResult.webhookUrl)}
                    >
                      {copiedUrl ? (
                        <Check className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Add this URL as a Website Hook in Crisp under{" "}
                    <strong>Settings → Advanced configuration → Webhooks</strong>.
                  </p>
                </div>

                <div className="flex justify-end pt-2 border-t border-border/40">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setIsAddModalOpen(false);
                      setAddSuccessResult(null);
                    }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* ========================================================================= */}
      {/* ADMIN VIEW WEBHOOK URL MODAL */}
      {/* ========================================================================= */}
      {isAdmin && viewWebhookWs && (
        <Dialog
          open={Boolean(viewWebhookWs)}
          onOpenChange={(open) => !open && setViewWebhookWs(null)}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                <Globe className="w-5 h-5 text-primary" />
                <span>Webhook URL</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Current Webhook URL for{" "}
                <strong>
                  {getWorkspaceDisplayName(viewWebhookWs.crisp_website_id, workspacesMap)}
                </strong>
                .
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 pt-2">
              {isFetchingWebhook ? (
                <div className="flex items-center justify-center p-6">
                  <Loader2 className="w-5 h-5 animate-spin text-primary mr-2" />
                  <span className="text-xs text-muted-foreground">
                    Retrieving Webhook Secret from Vault...
                  </span>
                </div>
              ) : viewWebhookUrl ? (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Website Hook Setup URL</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={viewWebhookUrl}
                      className="text-xs font-mono bg-muted/50 select-all"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-9 w-9"
                      onClick={() => handleCopyText(viewWebhookUrl)}
                    >
                      {copiedUrl ? (
                        <Check className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    This is the existing Webhook URL for this workspace. Paste it into Crisp under{" "}
                    <strong>Settings → Advanced configuration → Webhooks</strong>.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-destructive">Could not retrieve Webhook URL.</p>
              )}

              <div className="flex justify-end pt-2 border-t border-border/40">
                <Button type="button" size="sm" onClick={() => setViewWebhookWs(null)}>
                  Close
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ========================================================================= */}
      {/* ADMIN REGENERATE WEBHOOK DIALOG */}
      {/* ========================================================================= */}
      {isAdmin && regenWebhookWs && (
        <Dialog
          open={Boolean(regenWebhookWs)}
          onOpenChange={(open) => !open && setRegenWebhookWs(null)}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base font-semibold text-amber-500">
                <ShieldAlert className="w-5 h-5" />
                <span>Regenerate Webhook URL?</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
                Regenerating the webhook URL will invalidate the previous URL. You will need to
                replace the URL inside Crisp immediately.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 pt-2">
              {!regenResultUrl ? (
                <div className="flex justify-end gap-2 border-t border-border/40 pt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRegenWebhookWs(null)}
                    disabled={isRegenerating}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="bg-amber-500 hover:bg-amber-600 text-white"
                    onClick={handleConfirmRegenerateWebhook}
                    disabled={isRegenerating}
                  >
                    {isRegenerating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    ) : null}
                    <span>Regenerate Webhook URL</span>
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 font-medium">
                    New Webhook URL Generated. Replace it inside Crisp immediately.
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={regenResultUrl}
                      className="text-xs font-mono bg-muted/50 select-all"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-9 w-9"
                      onClick={() => handleCopyText(regenResultUrl)}
                    >
                      {copiedUrl ? (
                        <Check className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <div className="flex justify-end pt-2 border-t border-border/40">
                    <Button type="button" size="sm" onClick={() => setRegenWebhookWs(null)}>
                      Done
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ========================================================================= */}
      {/* ADMIN DELETE WORKSPACE DIALOG */}
      {/* ========================================================================= */}
      {isAdmin && deleteWs && (
        <Dialog open={Boolean(deleteWs)} onOpenChange={(open) => !open && setDeleteWs(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base font-semibold text-destructive">
                <Trash2 className="w-5 h-5" />
                <span>Delete Crisp Workspace?</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
                This will disconnect{" "}
                <strong>
                  "{getWorkspaceDisplayName(deleteWs.crisp_website_id, workspacesMap)}"
                </strong>{" "}
                from JellyBean. The Crisp credentials and webhook configuration stored for this
                workspace will no longer be used.
              </DialogDescription>
            </DialogHeader>

            <div className="flex justify-end gap-2 border-t border-border/40 pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeleteWs(null)}
                disabled={isDeletingWs}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleConfirmDeleteWorkspace}
                disabled={isDeletingWs}
              >
                {isDeletingWs ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                <span>Delete Workspace</span>
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );

  // Helper to copy existing Webhook URL directly from action menu
  async function handleCopyWebhookUrlFromWs(ws: WorkspaceRecord) {
    try {
      const res = await getCrispWorkspaceWebhookUrl({ data: { websiteId: ws.crisp_website_id } });
      if (!res.ok || !res.webhook_url) {
        toast.error(res.error || "Could not fetch Webhook URL");
      } else {
        handleCopyText(res.webhook_url);
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "Failed to fetch Webhook URL");
    }
  }
}
