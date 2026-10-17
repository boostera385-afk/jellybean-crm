import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles, Building2, MessageSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { updateCrispWorkspaceAutoGreet } from "@/lib/crisp.functions";
import {
  CRISP_FIRST_GREETING,
  CRISP_REVISIT_GREETING,
  CRISP_GREETING_MAX_LENGTH,
} from "@/lib/crisp-greeting-policy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

type CrispWorkspaceRow = {
  id: string;
  crisp_website_id: string;
  workspace_name: string | null;
  enabled: boolean;
  auto_greet_enabled: boolean | null;
  auto_greet_message: string | null;
  auto_greet_delay_seconds: number | null;
  auto_greet_revisit_enabled: boolean | null;
  auto_greet_revisit_message: string | null;
  auto_greet_revisit_after_seconds: number | null;
};

function workspaceLabel(ws: CrispWorkspaceRow): string {
  if (ws.workspace_name?.trim()) return ws.workspace_name.trim();
  const suffix = ws.crisp_website_id.slice(0, 8);
  return `Workspace • ${suffix}`;
}

export function CrispSettingsTab() {
  const workspacesQuery = useQuery({
    queryKey: ["crisp-workspaces-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crisp_workspaces")
        .select(
          "id, crisp_website_id, workspace_name, enabled, auto_greet_enabled, auto_greet_message, auto_greet_delay_seconds, auto_greet_revisit_enabled, auto_greet_revisit_message, auto_greet_revisit_after_seconds",
        )
        .eq("enabled", true)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CrispWorkspaceRow[];
    },
  });

  const workspaces = workspacesQuery.data ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="crm-section-panel">
        <div className="crm-surface-card p-5 space-y-1.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Auto-greeting for live visitors</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Automatically send a professional greeting the first time a visitor goes live, and a
            polite check-in on later visits. Both skip anyone who already started a chat. Use{" "}
            <code className="font-mono">{"{{name}}"}</code> and{" "}
            <code className="font-mono">{"{{city}}"}</code> as placeholders.
          </p>
        </div>
      </div>

      {workspacesQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading workspaces…
        </div>
      ) : workspacesQuery.isError ? (
        <div className="crm-surface-card p-5 text-xs text-destructive">
          Could not load Crisp workspaces. Please try again.
        </div>
      ) : workspaces.length === 0 ? (
        <div className="crm-surface-card p-5 text-xs text-muted-foreground">
          No connected Crisp workspaces yet. Connect one from the Crisp Chat page first.
        </div>
      ) : (
        <div className="space-y-4">
          {workspaces.map((ws) => (
            <CrispWorkspaceAutoGreetCard
              key={ws.id}
              workspace={ws}
              onSaved={() => void workspacesQuery.refetch()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CrispWorkspaceAutoGreetCard({
  workspace,
  onSaved,
}: {
  workspace: CrispWorkspaceRow;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(Boolean(workspace.auto_greet_enabled));
  const [message, setMessage] = useState(workspace.auto_greet_message ?? "");
  const [delay, setDelay] = useState(String(workspace.auto_greet_delay_seconds ?? 0));
  const [revisitEnabled, setRevisitEnabled] = useState(
    workspace.auto_greet_revisit_enabled !== false,
  );
  const [revisitMessage, setRevisitMessage] = useState(workspace.auto_greet_revisit_message ?? "");
  const [revisitHours, setRevisitHours] = useState(
    String((workspace.auto_greet_revisit_after_seconds ?? 1800) / 3600),
  );
  const [saving, setSaving] = useState(false);

  // Keep the form in sync when the underlying data refreshes after a save.
  useEffect(() => {
    setEnabled(Boolean(workspace.auto_greet_enabled));
    setMessage(workspace.auto_greet_message ?? "");
    setDelay(String(workspace.auto_greet_delay_seconds ?? 0));
    setRevisitEnabled(workspace.auto_greet_revisit_enabled !== false);
    setRevisitMessage(workspace.auto_greet_revisit_message ?? "");
    setRevisitHours(String((workspace.auto_greet_revisit_after_seconds ?? 1800) / 3600));
  }, [
    workspace.auto_greet_enabled,
    workspace.auto_greet_message,
    workspace.auto_greet_delay_seconds,
    workspace.auto_greet_revisit_enabled,
    workspace.auto_greet_revisit_message,
    workspace.auto_greet_revisit_after_seconds,
  ]);

  const dirty =
    enabled !== Boolean(workspace.auto_greet_enabled) ||
    message !== (workspace.auto_greet_message ?? "") ||
    String(Math.max(0, Math.round(Number(delay) || 0))) !==
      String(workspace.auto_greet_delay_seconds ?? 0) ||
    revisitEnabled !== (workspace.auto_greet_revisit_enabled !== false) ||
    revisitMessage !== (workspace.auto_greet_revisit_message ?? "") ||
    String(Number(revisitHours) || 0) !==
      String((workspace.auto_greet_revisit_after_seconds ?? 1800) / 3600);

  async function handleSave() {
    if (saving) return;
    if (enabled && !message.trim()) {
      toast.error("Add a greeting message before turning auto-greeting on.");
      return;
    }
    if (revisitEnabled && !revisitMessage.trim()) {
      toast.error("Add a revisit greeting message, or turn revisit greetings off.");
      return;
    }
    const parsedDelay = Math.max(0, Math.min(3600, Math.round(Number(delay) || 0)));
    const parsedHours = Math.min(Math.max(Number(revisitHours) || 0.5, 5 / 60), 168);
    setSaving(true);
    try {
      const res = await updateCrispWorkspaceAutoGreet({
        data: {
          websiteId: workspace.crisp_website_id,
          enabled,
          message: message.trim(),
          delaySeconds: parsedDelay,
          revisitEnabled,
          revisitMessage: revisitMessage.trim(),
          revisitAfterHours: parsedHours,
        },
      });
      if (!res.ok) {
        toast.error(res.error || "Could not save auto-greeting");
      } else {
        toast.success(
          enabled
            ? `Auto-greeting is on for ${workspaceLabel(workspace)}`
            : `Auto-greeting turned off for ${workspaceLabel(workspace)}`,
        );
        onSaved();
      }
    } catch (err: unknown) {
      toast.error((err as Error).message || "Failed to save auto-greeting");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="crm-surface-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Building2 className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold truncate">{workspaceLabel(workspace)}</h4>
            <p className="text-[11px] text-muted-foreground">
              {enabled ? "Auto-greeting enabled" : "Auto-greeting off"}
            </p>
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor={`greet-msg-${workspace.id}`}
          className="text-xs font-semibold flex items-center gap-1.5"
        >
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          Greeting message
        </Label>
        <Textarea
          id={`greet-msg-${workspace.id}`}
          placeholder={CRISP_FIRST_GREETING}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="min-h-24 text-xs resize-none"
          maxLength={CRISP_GREETING_MAX_LENGTH}
        />
        <p className="text-[11px] text-muted-foreground">
          {message.length}/{CRISP_GREETING_MAX_LENGTH} characters. Keep it to one short question; do
          not use names.
        </p>
      </div>

      <div className="rounded-lg border border-border/60 p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label className="text-xs font-semibold">Greet again on later visits</Label>
            <p className="text-[11px] text-muted-foreground max-w-sm">
              Sends one polite check-in when a returning visitor comes back online. Never repeats
              within the same visit, and never re-greets a visitor who already replied — those are
              followed up by a human.
            </p>
          </div>
          <Switch checked={revisitEnabled} onCheckedChange={setRevisitEnabled} />
        </div>
        {revisitEnabled && (
          <>
            <div className="space-y-1.5">
              <Label
                htmlFor={`revisit-msg-${workspace.id}`}
                className="text-xs font-semibold flex items-center gap-1.5"
              >
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                Revisit greeting message
              </Label>
              <Textarea
                id={`revisit-msg-${workspace.id}`}
                placeholder={CRISP_REVISIT_GREETING}
                value={revisitMessage}
                onChange={(e) => setRevisitMessage(e.target.value)}
                className="min-h-20 text-xs resize-none"
                maxLength={CRISP_GREETING_MAX_LENGTH}
              />
              <p className="text-[11px] text-muted-foreground">
                {revisitMessage.length}/{CRISP_GREETING_MAX_LENGTH} characters. Sent only on an
                eligible genuine return.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`revisit-hours-${workspace.id}`} className="text-xs font-semibold">
                Wait before greeting the same visitor again (hours)
              </Label>
              <Input
                id={`revisit-hours-${workspace.id}`}
                type="number"
                min={5 / 60}
                max={168}
                step={0.5}
                value={revisitHours}
                onChange={(e) => setRevisitHours(e.target.value)}
                className="h-9 w-40 text-xs"
              />
              <p className="text-[11px] text-muted-foreground max-w-xs">
                Minimum 0.08 (5 minutes), maximum 168 (7 days). Default 0.5 (30 minutes).
              </p>
            </div>
          </>
        )}
      </div>

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="space-y-1.5">
          <Label htmlFor={`greet-delay-${workspace.id}`} className="text-xs font-semibold">
            Delay before sending (seconds)
          </Label>
          <Input
            id={`greet-delay-${workspace.id}`}
            type="number"
            min={0}
            max={3600}
            step={1}
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            className="h-9 w-40 text-xs"
          />
          <p className="text-[11px] text-muted-foreground max-w-xs">
            0 = send immediately. Quick bouncers who leave before the delay are skipped.
          </p>
        </div>
        <Button type="button" size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
}
