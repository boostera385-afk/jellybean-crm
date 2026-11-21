// Settings for the JellyJar Chrome extension (table public.extension_settings)
// and the download that bakes them into the extension zip.
//
// The extension source lives in integrations/chrome-extension/JellyJar. The
// zip operators download is stored in the private crm-downloads bucket; on
// download the CRM replaces its crm-config.js with the saved settings, so every
// download starts with the team's current searches and keyword lists.
import JSZip from "jszip";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

export const EXTENSION_BUCKET = "crm-downloads";
export const EXTENSION_OBJECT = "JellyJar.zip";
export const EXTENSION_DOWNLOAD_NAME = "JellyJar.zip";

// Bounds the extension also enforces (apply-crm-config.js clamps to 10–3600).
export const MIN_SEARCH_SECONDS = 15;
export const MAX_SEARCH_SECONDS = 3600;

export type ExtensionSearch = {
  label: string;
  query: string;
  durationSeconds: number;
  enabled: boolean;
};

export type ExtensionSettings = {
  searches: ExtensionSearch[];
  includeKeywords: string[];
  excludeKeywords: string[];
  revision: number;
  updatedAt: string | null;
};

type SettingsRow = {
  searches: Json;
  include_keywords: string[];
  exclude_keywords: string[];
  revision: number;
  updated_at: string;
};

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSearches(value: Json): ExtensionSearch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, Json | undefined>;
    const query = cleanText(entry.query);
    const seconds = Math.round(Number(entry.durationSeconds) || 60);
    return [
      {
        label: cleanText(entry.label) || query,
        query,
        durationSeconds: seconds,
        enabled: entry.enabled !== false,
      },
    ];
  });
}

export function rowToSettings(row: SettingsRow): ExtensionSettings {
  return {
    searches: parseSearches(row.searches),
    includeKeywords: row.include_keywords ?? [],
    excludeKeywords: row.exclude_keywords ?? [],
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

/** Splits text on commas and new lines, trims, and drops case-insensitive repeats. */
export function parseKeywordText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\r\n,]+/)) {
    const keyword = cleanText(part);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

/** Problems that block saving, one message each; empty when the settings are valid. */
export function validateSettings(settings: Omit<ExtensionSettings, "revision" | "updatedAt">) {
  const problems: string[] = [];
  const enabled = settings.searches.filter((s) => s.enabled);
  if (enabled.length === 0) problems.push("Turn on at least one search.");
  settings.searches.forEach((search, index) => {
    const name = search.label || `Search ${index + 1}`;
    if (!cleanText(search.query)) problems.push(`${name}: add the search terms.`);
    if (
      !Number.isFinite(search.durationSeconds) ||
      search.durationSeconds < MIN_SEARCH_SECONDS ||
      search.durationSeconds > MAX_SEARCH_SECONDS
    ) {
      problems.push(
        `${name}: run time must be ${MIN_SEARCH_SECONDS}–${MAX_SEARCH_SECONDS} seconds.`,
      );
    }
  });
  if (settings.includeKeywords.length === 0) {
    problems.push("Add at least one include keyword, or the extension would capture every post.");
  }
  return problems;
}

/** The crm-config.js written into the downloaded extension. */
export function buildCrmConfigJs(settings: ExtensionSettings, generatedAt = new Date()): string {
  const config = {
    revision: settings.revision,
    generatedAt: generatedAt.toISOString(),
    searches: settings.searches
      .filter((s) => s.enabled && cleanText(s.query))
      .map((s) => ({
        label: cleanText(s.label) || cleanText(s.query),
        query: cleanText(s.query),
        durationSeconds: s.durationSeconds,
      })),
    includeKeywords: settings.includeKeywords,
    excludeKeywords: settings.excludeKeywords,
  };
  return [
    "// JellyJar — settings from the JellyBean CRM, written when this copy was downloaded.",
    "// Change them in the CRM (Browser Profiles → Extension settings) and download again.",
    `var JELLYJAR_CRM_CONFIG = ${JSON.stringify(config, null, 2)};`,
    "",
  ].join("\n");
}

export type BuiltExtension = {
  blob: Blob;
  /** False when the stored zip predates CRM settings (no apply-crm-config.js). */
  supportsCrmSettings: boolean;
};

/** Writes the settings into the extension zip, next to its manifest.json. */
export async function buildExtensionZip(
  baseZip: Blob,
  settings: ExtensionSettings,
): Promise<BuiltExtension> {
  const zip = await JSZip.loadAsync(await baseZip.arrayBuffer());
  const manifestPath = Object.keys(zip.files)
    .filter((name) => /(^|\/)manifest\.json$/.test(name) && !zip.files[name].dir)
    .sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) throw new Error("The extension zip has no manifest.json.");
  const folder = manifestPath.slice(0, manifestPath.length - "manifest.json".length);

  zip.file(`${folder}crm-config.js`, buildCrmConfigJs(settings));
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { blob, supportsCrmSettings: !!zip.file(`${folder}apply-crm-config.js`) };
}

export const EXTENSION_SETTINGS_QUERY_KEY = ["extension_settings"] as const;

export async function fetchExtensionSettings(): Promise<ExtensionSettings | null> {
  const { data, error } = await supabase
    .from("extension_settings")
    .select("searches, include_keywords, exclude_keywords, revision, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToSettings(data) : null;
}
