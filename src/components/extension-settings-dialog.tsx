// Edit what the JellyJar Chrome extension searches on Nextdoor: the search
// rotation (what each search looks for and how long it stays on that page) and
// the include / exclude keyword lists. Saved to public.extension_settings and
// baked into every extension download (see src/lib/extension-settings.ts).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EXTENSION_SETTINGS_QUERY_KEY,
  fetchExtensionSettings,
  MAX_SEARCH_SECONDS,
  MIN_SEARCH_SECONDS,
  parseKeywordText,
  rowToSettings,
  validateSettings,
  type ExtensionSearch,
} from "@/lib/extension-settings";
import type { Json } from "@/integrations/supabase/types";

type DraftSearch = ExtensionSearch & { key: string };

let draftKeySeq = 0;
const nextKey = () => `search-${++draftKeySeq}`;

function formatMinutes(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const minutes = Math.round((totalSeconds / 60) * 10) / 10;
  return `${minutes} min`;
}

export function ExtensionSettingsDialog({
  open,
  onOpenChange,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: EXTENSION_SETTINGS_QUERY_KEY,
    queryFn: fetchExtensionSettings,
    enabled: open,
  });

  const [searches, setSearches] = useState<DraftSearch[]>([]);
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load the saved settings into the form once each time the dialog opens, so a
  // background refetch doesn't wipe unsaved edits.
  useEffect(() => {
    if (!open) {
      setLoaded(false);
      return;
    }
    if (loaded || !settings.data) return;
    setSearches(settings.data.searches.map((s) => ({ ...s, key: nextKey() })));
    setIncludeText(settings.data.includeKeywords.join(", "));
    setExcludeText(settings.data.excludeKeywords.join(", "));
    setLoaded(true);
  }, [open, loaded, settings.data]);

  const includeKeywords = useMemo(() => parseKeywordText(includeText), [includeText]);
  const excludeKeywords = useMemo(() => parseKeywordText(excludeText), [excludeText]);
  const enabledSearches = searches.filter((s) => s.enabled);
  const runSeconds = enabledSearches.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
  const problems = validateSettings({ searches, includeKeywords, excludeKeywords });

  const updateSearch = (key: string, patch: Partial<ExtensionSearch>) =>
    setSearches((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const moveSearch = (index: number, delta: number) =>
    setSearches((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const removeSearch = (key: string) => setSearches((list) => list.filter((s) => s.key !== key));
  const addSearch = () =>
    setSearches((list) => [
      ...list,
      { key: nextKey(), label: "", query: "", durationSeconds: 60, enabled: true },
    ]);

  const save = async () => {
    if (problems.length) {
      toast.error(problems[0]);
      return;
    }
    setSaving(true);
    try {
      const payload = searches.map(({ label, query, durationSeconds, enabled }) => ({
        label: label.trim() || query.trim(),
        query: query.trim(),
        durationSeconds,
        enabled,
      }));
      const { data, error } = await supabase
        .from("extension_settings")
        .update({
          searches: payload as unknown as Json,
          include_keywords: includeKeywords,
          exclude_keywords: excludeKeywords,
        })
        .eq("id", 1)
        .select("revision")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("You don't have permission to change the extension settings.");
      await qc.invalidateQueries({ queryKey: EXTENSION_SETTINGS_QUERY_KEY });
      toast.success("Extension settings saved", {
        description:
          "New downloads use these settings. Installed extensions keep their old settings until they are downloaded again.",
      });
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the extension settings.");
    } finally {
      setSaving(false);
    }
  };

  const readOnly = !canEdit;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Extension settings</DialogTitle>
          <DialogDescription>
            What the JellyJar extension searches on Nextdoor. Every extension download includes
            these settings; installed copies keep their old settings until they are downloaded
            again.
            {readOnly && " Only admins can change them."}
          </DialogDescription>
        </DialogHeader>

        {settings.isLoading ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
          </div>
        ) : settings.error || !settings.data ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[13px]">
            Could not load the extension settings
            {settings.error instanceof Error ? `: ${settings.error.message}` : "."}
          </div>
        ) : (
          <Tabs defaultValue="searches">
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto p-1.5 sm:w-auto">
              <TabsTrigger value="searches">Searches ({enabledSearches.length})</TabsTrigger>
              <TabsTrigger value="include">Include keywords ({includeKeywords.length})</TabsTrigger>
              <TabsTrigger value="exclude">Exclude keywords ({excludeKeywords.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="searches" className="space-y-3 pt-2">
              <p className="text-[12px] text-muted-foreground">
                The extension runs the searches that are on, in this order, once per run:{" "}
                <strong className="text-foreground">
                  {enabledSearches.length} searches, about {formatMinutes(runSeconds)}
                </strong>
                . Search terms are what is typed into Nextdoor search; separate several with commas.
                Run time is how long it stays on that search page.
              </p>

              <div className="hidden grid-cols-[44px_minmax(0,1fr)_minmax(0,1.6fr)_96px_96px] gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid">
                <span>On</span>
                <span>Service</span>
                <span>Search terms</span>
                <span>Run time (sec)</span>
                <span />
              </div>

              <div className="space-y-2">
                {searches.map((search, index) => (
                  <div
                    key={search.key}
                    className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 rounded-md border p-2 md:grid-cols-[44px_minmax(0,1fr)_minmax(0,1.6fr)_96px_96px] md:items-center md:border-0 md:p-1"
                  >
                    <div className="flex items-center">
                      <Switch
                        checked={search.enabled}
                        disabled={readOnly}
                        onCheckedChange={(checked) =>
                          updateSearch(search.key, { enabled: checked })
                        }
                        aria-label={`Run ${search.label || "this search"}`}
                      />
                    </div>
                    <Input
                      value={search.label}
                      disabled={readOnly}
                      placeholder="Service name"
                      aria-label="Service name"
                      onChange={(e) => updateSearch(search.key, { label: e.target.value })}
                      className="h-9"
                    />
                    <Input
                      value={search.query}
                      disabled={readOnly}
                      placeholder="e.g. Pressure Washing, Gutter Cleaning"
                      aria-label="Search terms"
                      onChange={(e) => updateSearch(search.key, { query: e.target.value })}
                      className="col-start-2 h-9 md:col-start-auto"
                    />
                    <Input
                      type="number"
                      min={MIN_SEARCH_SECONDS}
                      max={MAX_SEARCH_SECONDS}
                      step={5}
                      value={Number.isFinite(search.durationSeconds) ? search.durationSeconds : ""}
                      disabled={readOnly}
                      aria-label="Run time in seconds"
                      onChange={(e) =>
                        updateSearch(search.key, {
                          durationSeconds:
                            e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)),
                        })
                      }
                      className="col-start-2 h-9 md:col-start-auto"
                    />
                    <div className="col-start-2 flex items-center gap-1 md:col-start-auto">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={readOnly || index === 0}
                        onClick={() => moveSearch(index, -1)}
                        aria-label="Move up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={readOnly || index === searches.length - 1}
                        onClick={() => moveSearch(index, 1)}
                        aria-label="Move down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        disabled={readOnly}
                        onClick={() => removeSearch(search.key)}
                        aria-label={`Remove ${search.label || "search"}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {!readOnly && (
                <Button variant="outline" size="sm" onClick={addSearch}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add search
                </Button>
              )}
            </TabsContent>

            <TabsContent value="include" className="space-y-2 pt-2">
              <p className="text-[12px] text-muted-foreground">
                A post is captured only if it contains one of these. Separate keywords with commas
                or new lines.
              </p>
              <Textarea
                value={includeText}
                disabled={readOnly}
                onChange={(e) => setIncludeText(e.target.value)}
                className="min-h-[280px] font-mono text-[12px]"
                aria-label="Include keywords"
              />
            </TabsContent>

            <TabsContent value="exclude" className="space-y-2 pt-2">
              <p className="text-[12px] text-muted-foreground">
                Posts containing any of these are skipped, such as ads and business promotions.
                Separate keywords with commas or new lines.
              </p>
              <Textarea
                value={excludeText}
                disabled={readOnly}
                onChange={(e) => setExcludeText(e.target.value)}
                className="min-h-[280px] font-mono text-[12px]"
                aria-label="Exclude keywords"
              />
            </TabsContent>
          </Tabs>
        )}

        {settings.data && (
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[11px] text-muted-foreground">
              Version {settings.data.revision}
              {settings.data.updatedAt &&
                ` · saved ${new Date(settings.data.updatedAt).toLocaleString()}`}
            </span>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {canEdit && problems.length > 0 && (
                <span className="text-[12px] text-destructive">{problems[0]}</span>
              )}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {canEdit ? "Cancel" : "Close"}
              </Button>
              {canEdit && (
                <Button onClick={save} disabled={saving || problems.length > 0}>
                  {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Save
                </Button>
              )}
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
