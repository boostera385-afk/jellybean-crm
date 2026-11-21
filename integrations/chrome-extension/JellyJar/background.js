// JellyJar — Background Service Worker

const DEFAULT_SEARCH_URL = "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=b71b3118-bde1-4804-a7ac-fdcc4769ca5e&query=garage+door+repair&postDistance=50&postDistanceUnit=MILES&postDateFilter=TODAY";
const SINGLE_SEARCH_TEMPLATE_URL = "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=b71b3118-bde1-4804-a7ac-fdcc4769ca5e&query=handyman&postDistance=50&postDistanceUnit=MILES&postDateFilter=TODAY";
importScripts("defaults.js", "include-defaults.js", "crm-config.js", "apply-crm-config.js");

const DEFAULT_WEBHOOK_URL = "https://jellybean-crm.lovable.app/api/public/nextdoor-leads";
const SEARCH_DURATION_VARIATION_SECONDS = 5;
// Built-in rotation, used when the download has no CRM searches (crm-config.js).
const BUILT_IN_SEARCH_SEQUENCE = [
  { label: "Search: garage door repair", durationSeconds: 60, url: DEFAULT_SEARCH_URL },
  { label: "Search: appliance repair", durationSeconds: 60, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=acdab0f0-eda8-4927-95ae-0d04d7e18f4f&query=Appliance%20Repair&postDistance=50&postDistanceUnit=MILES&postDateFilter=TODAY" },
  { label: "Search: painting", durationSeconds: 60, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=6544aedf-21f0-4caf-91e9-5a5874585923&query=Painting&postDistance=50&postDistanceUnit=MILES&postDateFilter=TODAY" },
  { label: "Search: drywall", durationSeconds: 60, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=25178b80-ee41-4978-a485-69cc446c26c0&query=Drywall&postDistance=50&postDistanceUnit=MILES&postDateFilter=TODAY" },
  { label: "Search: junk removal", durationSeconds: 30, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=554e912e-c058-4762-b2ae-ce7fd509ac0b&query=Junk+Removal&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES" },
  { label: "Search: exterior cleaning", durationSeconds: 60, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=0e904dc4-2e32-46fa-aa70-cef00aaf7cc0&query=Pressure+Washing%2C+Gutter+Cleaning%2C+Window+Cleaning&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES" },
  { label: "Search: carpet and upholstery", durationSeconds: 60, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=8546a601-b9dc-4502-836b-e1a56f446f8e&query=Carpet%20Cleaning%2C%20Upholstery%20Cleaning&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES" },
  { label: "Search: moving", durationSeconds: 30, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=6a9c518f-76aa-4089-a49e-7a33af9546e1&query=Moving&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES" },
  { label: "Search: furniture assembly", durationSeconds: 30, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=e5b43ae5-cf5f-4a5b-bfba-1cf6217a0402&query=Furniture+Assembly&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES" },
  { label: "Search: permanent and Christmas lights", durationSeconds: 60, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=8c7b28a2-d09a-44b2-87f5-3283867f39c3&query=Govee+Permanent+Lights%2C+Christmas+Lights&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES" },
  { label: "Search: small installations", durationSeconds: 60, url: "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=a4bb0032-5f06-49c3-b6dd-4ef48cd9c064&query=outlet%20replacement%2C%20picture%20hanging%2C%20TV%20Mounting%2C%20Toilet%20Inner%20Kit%20replacement&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES" },
];

const CONFIG_REVISION = 4;

const STORAGE_KEY = "nd_posts";
const SEEN_KEY = "nd_seen_ids";
const STATS_KEY = "nd_stats";
const SCAN_LOGS_KEY = "nd_scan_logs";
const CONFIG_KEY = "ndConfig";
const SHEETS_QUEUE_KEY = "nd_sheets_queue";
const AUTO_STATE_KEY = "nd_auto_cycle";
const MAX_POSTS = 10000;
const MAX_SEEN = 50000;
const MAX_SCAN_LOGS = 25000;
const WEBHOOK_SCHEMA_VERSION = "2026-04-08.nd.v1";
const SHEETS_SYNC_BATCH_SIZE = 15;
const SHEETS_SYNC_BATCH_DELAY_MS = 3000;
const SHEETS_RETRY_BASE_MS = 15000;
const SHEETS_RATE_LIMIT_RETRY_MS = 60000;
const SHEETS_RETRY_MAX_MS = 15 * 60 * 1000;
const NEIGHBORHOOD_POST_LIMIT = 20;
const NEIGHBORHOOD_PROGRESS_POLL_MS = 1000;
const NEIGHBORHOOD_INITIAL_WAIT_MS = 10000;
const NEIGHBORHOOD_SECOND_WAIT_MS = 10000;
const NEIGHBORHOOD_SCAN_WINDOW_MS = 15000;
const NEIGHBORHOOD_FEED_RETRY_WAIT_MS = 6000;
const NEIGHBORHOOD_FEED_RECOVERY_GRACE_MS = 8000;

const FLUSH_INTERVAL_MS = 1000;
const RETRY_FLUSH_INTERVAL_MS = SHEETS_RETRY_BASE_MS;
const ALARM_SHEETS_FLUSH = "nd_sheets_flush";
const ALARM_AUTO_CYCLE = "nd_auto_cycle_alarm";
const ALARM_RESUME_JOBS = "nd_resume_jobs_alarm";

const DEBUG = true;

function dlog(...args) {
  if (!DEBUG) return;
  console.log("[ND-BG]", ...args);
}

function dwarn(...args) {
  if (!DEBUG) return;
  console.warn("[ND-BG]", ...args);
}

function derror(...args) {
  if (!DEBUG) return;
  console.error("[ND-BG]", ...args);
}

function maskUrlForLog(url) {
  const text = cleanTextValue(url);
  if (!text) return "";
  try {
    const u = new URL(text);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return `${text.slice(0, 32)}...`;
  }
}

function normalizeUrlForCompare(url) {
  try {
    const u = new URL(String(url || ""));
    u.hash = "";
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return cleanTextValue(url);
  }
}

function getRowDebugSummary(row) {
  return {
    id: getQueueRowIdentifier(row),
    accountName: cleanTextValue(row && row.accountName).slice(0, 80),
    postTextLength: cleanTextValue(row && (row.postText || row.text)).length,
    hasProfileLink: !!cleanTextValue(row && row.profileLink),
    hasPostLink: !!cleanTextValue(row && row.postLink),
    hasFinalLink: !!cleanTextValue(row && row.finalLink),
    sourceMode: cleanTextValue(row && row.sourceMode),
  };
}

function summarizeWebhookBodyForError(text) {
  const body = cleanTextValue(text);
  if (!body) return "empty_response";
  if (/^\s*<!doctype\s+html/i.test(text) || /^\s*<html[\s>]/i.test(text)) {
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const h1Match = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = cleanTextValue((titleMatch && titleMatch[1]) || (h1Match && h1Match[1]) || "");
    return title ? `crm_returned_html_page:${title}` : "crm_returned_html_page";
  }
  return body.slice(0, 300);
}

let sheetsFlushInProgress = false;
let sheetsRetryAttempt = 0;
let sheetsNextRetryAt = 0;
let runControlChain = Promise.resolve();

function withRunControl(task) {
  const next = runControlChain.then(task, task);
  runControlChain = next.catch(() => {});
  return next;
}

function getEmptyStats() {
  return {
    totalCaptured: 0,
    totalSynced: 0,
    totalSkipped: 0,
    totalDuplicates: 0,
    totalPreCaptureSkipped: 0,
    sessionCaptured: 0,
    sessionSynced: 0,
    sessionSkipped: 0,
    sessionDuplicates: 0,
    sessionPreCaptureSkipped: 0,
    sessionStartedAt: 0,
    skippedReasons: {},
    preCaptureReasons: {},
    cycleCount: 0,
    cycling: false,
    lastSyncAt: "",
    lastSyncStatus: "",
    scanDiagnostics: {
      scanned: 0,
      accepted: 0,
      rejected: 0,
      reasons: {},
    },
  };
}

function emitMessage(msg) {
  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {}
  });
}

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function createAlarm(name, delayMs) {
  const when = Date.now() + Math.max(1000, Number(delayMs) || 1000);
  chrome.alarms.create(name, { when });
}

function clearAlarm(name) {
  return new Promise((resolve) => chrome.alarms.clear(name, resolve));
}

function cleanTextValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function deriveCapturedDate(rawDate, captureDateTime) {
  const explicit = cleanTextValue(rawDate);
  if (explicit) return explicit;
  const iso = cleanTextValue(captureDateTime);
  if (!iso.includes("T")) return "";
  return cleanTextValue(iso.split("T")[0] || "");
}

function deriveCapturedTime(rawTime, captureDateTime) {
  const explicit = cleanTextValue(rawTime);
  if (explicit && /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*UTC)?$/i.test(explicit)) return explicit;
  const source = explicit || cleanTextValue(captureDateTime);
  if (!source.includes("T")) return explicit;
  return cleanTextValue((source.split("T")[1] || "").replace("Z", " UTC"));
}

function getQueueRowIdentifier(row) {
  return cleanTextValue(
    (row && (row.queueItemId || row.id || row.postId || row.finalLink || row.profileLink || row.postLink)) || ""
  );
}

function hasActiveFilters(config) {
  const keywords = Array.isArray(config && config.keywords)
    ? config.keywords
    : String((config && config.keywords) || "").split(/[\n,]+/);
  const keywordCount = keywords.map(cleanTextValue).filter(Boolean).length;
  return keywordCount > 0 || !!(config && config.useSmartMatch);
}

function hasNeighborhoodTargets(config) {
  const raw = Array.isArray(config && config.neighborhoodList)
    ? config.neighborhoodList
    : String((config && config.neighborhoodList) || "").split(/\r?\n/);
  return raw.map(cleanTextValue).filter(Boolean).length > 0;
}

function getCycleSegments(config) {
  const totalScrollMs = Math.max(1, Number(config.scrollMinutes || 15)) * 60 * 1000;
  const sourceMode = String(config.sourceMode || "recent").toLowerCase();
  if (sourceMode === "neighborhood") {
    return [{ sourceMode: "neighborhood", durationMs: totalScrollMs, cycleStart: true, label: "Neighborhood Wise" }];
  }
  if (sourceMode === "search") {
    if (String(config.searchPlanMode || "rotation").toLowerCase() === "single") {
      const keyword = cleanTextValue(config.singleSearchKeyword || "handyman") || "handyman";
      return [{
        sourceMode: "search",
        durationMs: Math.max(1, Number(config.singleSearchMinutes || 15)) * 60 * 1000,
        cycleStart: true,
        label: `Search: ${keyword}`,
        searchUrl: buildSingleKeywordSearchUrl(keyword),
      }];
    }
    return buildSearchCycleSegments(config, true);
  }
  if (sourceMode !== "both") {
    return [{ sourceMode: sourceMode === "search" ? "search" : "recent", durationMs: totalScrollMs, cycleStart: true, label: sourceMode === "search" ? "Search" : "Recent" }];
  }

  const firstHalf = Math.max(1000, Math.floor(totalScrollMs / 2));
  const secondHalf = Math.max(1000, totalScrollMs - firstHalf);
  const singleKeyword = cleanTextValue(config.singleSearchKeyword || "handyman") || "handyman";
  const searchSegments = String(config.searchPlanMode || "rotation").toLowerCase() === "single"
    ? [{
        sourceMode: "search",
        durationMs: secondHalf,
        cycleStart: false,
        label: `Search: ${singleKeyword}`,
        searchUrl: buildSingleKeywordSearchUrl(singleKeyword),
      }]
    : buildSearchCycleSegments(config, false);
  return [
    { sourceMode: "recent", durationMs: firstHalf, cycleStart: true, label: "Recent" },
    ...searchSegments,
  ];
}

// The searches to rotate through: the CRM list baked into this download, or
// the built-in list when there is none.
function getSearchSequence() {
  if (Array.isArray(JELLYJAR_CRM_SEARCHES) && JELLYJAR_CRM_SEARCHES.length) {
    return JELLYJAR_CRM_SEARCHES.map((entry) => ({
      label: `Search: ${entry.label}`,
      durationSeconds: entry.durationSeconds,
      url: buildSingleKeywordSearchUrl(entry.query),
    }));
  }
  return BUILT_IN_SEARCH_SEQUENCE;
}

function buildSearchCycleSegments(_config, cycleStart) {
  return getSearchSequence().map((entry, index) => {
    const baseDurationSeconds = Math.max(1, Number(entry.durationSeconds || 60));
    const variationSeconds = index % 2 === 0
      ? SEARCH_DURATION_VARIATION_SECONDS
      : -SEARCH_DURATION_VARIATION_SECONDS;
    return {
      sourceMode: "search",
      durationMs: Math.max(1000, (baseDurationSeconds + variationSeconds) * 1000),
      cycleStart: index === 0 ? !!cycleStart : false,
      label: entry.label,
      searchUrl: entry.url,
    };
  });
}

function buildSingleKeywordSearchUrl(keyword) {
  const url = new URL(SINGLE_SEARCH_TEMPLATE_URL);
  url.searchParams.set("query", cleanTextValue(keyword) || "handyman");
  return url.toString();
}

function getResumeDelayMs(autoState) {
  const nextRunAt = Number((autoState && autoState.nextRunAt) || 0);
  if (!nextRunAt) return 15000;
  return Math.max(5000, Math.min(60000, nextRunAt - Date.now()));
}

function getRunDeadlineAt(config, existingDeadlineAt = 0, resetDeadline = false) {
  const configuredHours = Number(config && config.cycleDurationHours);
  if (!(configuredHours > 0)) return 0;
  if (!resetDeadline && Number(existingDeadlineAt || 0) > Date.now()) {
    return Number(existingDeadlineAt);
  }
  return Date.now() + configuredHours * 60 * 60 * 1000;
}

function normalizeDedupText(value, maxLen = 500) {
  return cleanTextValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isValidNextdoorSearchUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = (u.hostname || "").toLowerCase();
    if (!(host === "nextdoor.com" || host.endsWith(".nextdoor.com"))) return false;
    return (u.pathname || "").startsWith("/search/posts/");
  } catch {
    return false;
  }
}

function getEffectiveSearchUrl(rawUrl) {
  const explicitUrl = String(rawUrl || "").trim();
  if (isValidNextdoorSearchUrl(explicitUrl)) return explicitUrl;
  return DEFAULT_SEARCH_URL;
}

function slugifyNeighborhoodPart(value) {
  return cleanTextValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function slugifyCityPart(value) {
  return cleanTextValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildNeighborhoodUrl(city, neighborhood, stateCode = "ca") {
  const neighborhoodSlug = slugifyNeighborhoodPart(neighborhood);
  const citySlug = slugifyCityPart(city);
  const stateSlug = cleanTextValue(stateCode || "ca")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!neighborhoodSlug || !citySlug || !stateSlug) return "";
  return `https://nextdoor.com/neighborhood/${neighborhoodSlug}--${citySlug}--${stateSlug}/?source=settings`;
}

function normalizeNeighborhoodIdentity(value) {
  return cleanTextValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseNeighborhoodTargets(config) {
  const stateCode = cleanTextValue((config && config.neighborhoodStateCode) || "ca").toLowerCase() || "ca";
  const rawLines = Array.isArray(config && config.neighborhoodList)
    ? config.neighborhoodList
    : String((config && config.neighborhoodList) || "").split(/\r?\n/);
  const entries = [];
  let currentCity = "";

  for (const rawLine of rawLines) {
    const line = cleanTextValue(rawLine);
    if (!line) continue;

    const directPathMatch = line.match(/^(https?:\/\/[^/]+)?(\/neighborhood\/[a-z0-9-]+\/?)(?:\?.*)?$/i);
    if (directPathMatch) {
      const path = cleanTextValue(directPathMatch[2] || "").replace(/\/+$/g, "");
      const url = `https://nextdoor.com${path}/`;
      const slug = path.split("/").filter(Boolean).pop() || "";
      const slugParts = slug.split("--").map(cleanTextValue).filter(Boolean);
      const neighborhoodSlug = slugParts[0] || slug;
      const citySlug = slugParts[1] || "";
      entries.push({
        city: citySlug,
        neighborhood: neighborhoodSlug,
        stateCode,
        url,
        label: neighborhoodSlug,
      });
      continue;
    }

    let city = "";
    let neighborhoods = [];

    if (line.includes(":")) {
      const idx = line.indexOf(":");
      city = cleanTextValue(line.slice(0, idx));
      const rest = cleanTextValue(line.slice(idx + 1));
      if (rest) {
        neighborhoods = rest
          .split(",")
          .map(cleanTextValue)
          .filter(Boolean);
      } else {
        currentCity = city;
        continue;
      }
    } else if (line.includes("|")) {
      const parts = line.split("|").map(cleanTextValue).filter(Boolean);
      city = parts.shift() || "";
      neighborhoods = parts;
    } else if (currentCity) {
      city = currentCity;
      neighborhoods = [line];
    }

    if (!city || !neighborhoods.length) continue;
    currentCity = city;

    for (const neighborhood of neighborhoods) {
      const url = buildNeighborhoodUrl(city, neighborhood, stateCode);
      if (!url) continue;
      entries.push({
        city,
        neighborhood,
        stateCode,
        url,
        label: `${neighborhood}, ${city}`,
      });
    }
  }

  return entries;
}

function resolveTabSourceMode(baseMode, index, totalTabs) {
  const mode = String(baseMode || "recent").toLowerCase();
  if (mode === "recent" || mode === "search" || mode === "neighborhood") return mode;
  if (mode === "both") {
    if (totalTabs <= 1) return "recent";
    return index % 2 === 0 ? "recent" : "search";
  }
  return "recent";
}

async function getConfig() {
  const { [CONFIG_KEY]: cfg = {} } = await storageGet({ [CONFIG_KEY]: {} });
  let effectiveConfig = cfg;
  if (Number(cfg.configRevision || 0) < CONFIG_REVISION) {
    effectiveConfig = {
      ...cfg,
      configRevision: CONFIG_REVISION,
      sourceMode: "search",
      searchPlanMode: "rotation",
      searchUrl: DEFAULT_SEARCH_URL,
      keywords: DEFAULT_INCLUDE_KEYWORDS,
      restMinutes: 0,
      scrollDelayMs: Number(cfg.scrollDelayMs || 1000),
    };
    await storageSet({ [CONFIG_KEY]: effectiveConfig });
  }
  // A download from the CRM carries its keyword lists. Apply them once per CRM
  // revision: edits made in the popup afterwards stay until the next download
  // with newer CRM settings replaces them.
  if (JELLYJAR_CRM_REVISION && Number(effectiveConfig.crmConfigRevision || 0) !== JELLYJAR_CRM_REVISION) {
    effectiveConfig = {
      ...effectiveConfig,
      crmConfigRevision: JELLYJAR_CRM_REVISION,
      keywords: DEFAULT_INCLUDE_KEYWORDS,
      excludeKeywords: DEFAULT_EXCLUDE_KEYWORDS,
    };
    await storageSet({ [CONFIG_KEY]: effectiveConfig });
  }
  const sourceMode = String(effectiveConfig.sourceMode || "search").toLowerCase();
  const searchUrl = getEffectiveSearchUrl(effectiveConfig.searchUrl);
  return {
    ...effectiveConfig,
    sourceMode,
    searchUrl,
  };
}

async function getPosts() {
  const { [STORAGE_KEY]: posts = [] } = await storageGet({ [STORAGE_KEY]: [] });
  return Array.isArray(posts) ? posts : [];
}

async function getScanLogs() {
  const { [SCAN_LOGS_KEY]: logs = [] } = await storageGet({ [SCAN_LOGS_KEY]: [] });
  return Array.isArray(logs) ? logs : [];
}

async function getSeen() {
  const { [SEEN_KEY]: seen = [] } = await storageGet({ [SEEN_KEY]: [] });
  return Array.isArray(seen) ? seen : [];
}

async function getStats() {
  const { [STATS_KEY]: stats = getEmptyStats() } = await storageGet({ [STATS_KEY]: getEmptyStats() });
  return {
    ...getEmptyStats(),
    ...stats,
    skippedReasons: { ...getEmptyStats().skippedReasons, ...(stats.skippedReasons || {}) },
    preCaptureReasons: { ...getEmptyStats().preCaptureReasons, ...(stats.preCaptureReasons || {}) },
    scanDiagnostics: { ...getEmptyStats().scanDiagnostics, ...(stats.scanDiagnostics || {}) },
  };
}

async function setStats(patch) {
  const current = await getStats();
  const next = {
    ...current,
    ...patch,
    skippedReasons: { ...(current.skippedReasons || {}), ...((patch && patch.skippedReasons) || {}) },
    preCaptureReasons: { ...(current.preCaptureReasons || {}), ...((patch && patch.preCaptureReasons) || {}) },
  };
  await storageSet({ [STATS_KEY]: next });
  emitMessage({ type: "STATS_UPDATED", stats: next });
  return next;
}

async function resetSessionStats() {
  const stats = await getStats();
  const next = {
    ...stats,
    sessionCaptured: 0,
    sessionSynced: 0,
    sessionSkipped: 0,
    sessionDuplicates: 0,
    sessionPreCaptureSkipped: 0,
    sessionStartedAt: Date.now(),
    skippedReasons: {},
    preCaptureReasons: {},
    scanDiagnostics: {
      scanned: 0,
      accepted: 0,
      rejected: 0,
      reasons: {},
    },
  };
  await storageSet({ [STATS_KEY]: next });
  emitMessage({ type: "STATS_UPDATED", stats: next });
  return next;
}

function parseRetryAfterMs(value) {
  const raw = cleanTextValue(value);
  if (!raw) return 0;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(raw);
  return Number.isNaN(retryAt) ? 0 : Math.max(0, retryAt - Date.now());
}

function createWebhookError(reason, response) {
  const message = cleanTextValue(reason || `Webhook responded ${response && response.status}`) || "webhook_failed";
  const error = new Error(message);
  error.httpStatus = Number(response && response.status) || 0;
  error.rateLimited = error.httpStatus === 429 || /rate[\s_-]*limit|too many requests/i.test(message);
  error.retryAfterMs = parseRetryAfterMs(response && response.headers && response.headers.get("Retry-After"));
  return error;
}

async function postWebhookJson(webhookUrl, payload) {
  const startedAt = Date.now();
  dlog("[CRM] request:start", {
    url: maskUrlForLog(webhookUrl),
    action: cleanTextValue(payload && payload.action),
    rowCount: Array.isArray(payload && payload.rows) ? payload.rows.length : 0,
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
  });

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: WEBHOOK_SCHEMA_VERSION, ...payload }),
  });

  const text = await res.text();
  dlog("[CRM] response:raw", {
    action: cleanTextValue(payload && payload.action),
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    durationMs: Date.now() - startedAt,
    bodyPreview: cleanTextValue(text).slice(0, 1000),
  });

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const reason = summarizeWebhookBodyForError(text);
    dwarn("[CRM] response was not valid JSON", {
      action: cleanTextValue(payload && payload.action),
      status: res.status,
      reason,
      bodyPreview: cleanTextValue(text).slice(0, 1000),
    });
    if (res.ok) {
      throw new Error(`crm_non_json_response:${reason}`);
    }
    data = { reason };
  }

  if (!res.ok) {
    const reason = cleanTextValue(data.message || data.reason || summarizeWebhookBodyForError(text) || `Webhook responded ${res.status}`);
    derror("[CRM] request:http_error", {
      action: cleanTextValue(payload && payload.action),
      status: res.status,
      reason,
    });
    throw createWebhookError(reason, res);
  }

  const responseSchemaVersion = cleanTextValue(data.schemaVersion || "");
  if (responseSchemaVersion && responseSchemaVersion !== WEBHOOK_SCHEMA_VERSION) {
    derror("[CRM] response schema mismatch", {
      expected: WEBHOOK_SCHEMA_VERSION,
      received: responseSchemaVersion,
    });
    throw new Error(`schema_version_mismatch:${responseSchemaVersion}`);
  }

  dlog("[CRM] response:parsed", {
    action: cleanTextValue(payload && payload.action),
    ok: data.ok,
    status: data.status,
    added: data.added,
    acceptedCount: Array.isArray(data.acceptedIds) ? data.acceptedIds.length : 0,
    skippedCount: Array.isArray(data.skippedIds) ? data.skippedIds.length : 0,
    reason: cleanTextValue(data.reason || data.message),
  });

  return data;
}

function buildDedupKeys(post) {
  const postLink = cleanTextValue(post.postLink || "");
  const finalLink = cleanTextValue(post.finalLink || "");
  const profileLink = cleanTextValue(post.profileLink || "");
  const author = normalizeDedupText(post.accountName || post.author || "", 120);
  const timeLabel = normalizeDedupText(post.postDateTime || post.timestampLabel || "", 120);
  const text = normalizeDedupText(post.postText || post.text || "", 700);
  const keys = [];

  if (postLink) keys.push(`post:${postLink}`);
  if (!postLink && /^https?:\/\/[^/]+\/p\//i.test(finalLink)) keys.push(`post:${finalLink}`);
  if (profileLink && text) keys.push(`profile_text:${profileLink}|${text}`);
  if (author && timeLabel && text) keys.push(`content:${author}|${timeLabel}|${text}`);
  if (!keys.length && text) keys.push(`text:${text}`);

  return Array.from(new Set(keys));
}

function normalizeLogEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    logId: cleanTextValue(raw.logId || `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`),
    scanLogKey: cleanTextValue(raw.scanLogKey),
    queueItemId: cleanTextValue(raw.queueItemId),
    sessionId: cleanTextValue(raw.sessionId),
    scannedAt: cleanTextValue(raw.scannedAt || new Date().toISOString()),
    decision: cleanTextValue(raw.decision || "unknown"),
    reason: cleanTextValue(raw.reason || "unknown"),
    reasonSource: cleanTextValue(raw.reasonSource),
    reasonDetail: cleanTextValue(raw.reasonDetail),
    captureStatus: cleanTextValue(raw.captureStatus || "unknown"),
    saveReason: cleanTextValue(raw.saveReason),
    syncStatus: cleanTextValue(raw.syncStatus || "not_applicable"),
    syncReason: cleanTextValue(raw.syncReason),
    syncedAt: cleanTextValue(raw.syncedAt),
    accountName: cleanTextValue(raw.accountName),
    subArea: cleanTextValue(raw.subArea),
    postDateTime: cleanTextValue(raw.postDateTime),
    postText: cleanTextValue(raw.postText),
    finalLink: cleanTextValue(raw.finalLink),
    profileLink: cleanTextValue(raw.profileLink),
    postLink: cleanTextValue(raw.postLink),
    linkStatus: cleanTextValue(raw.linkStatus),
    linkAttempts: Number(raw.linkAttempts || 0),
    sourceMode: cleanTextValue(raw.sourceMode),
    pageUrl: cleanTextValue(raw.pageUrl || raw.capturedFromUrl),
    accountArea: cleanTextValue(raw.accountArea),
    incogAccount: cleanTextValue(raw.incogAccount),
    matchedReason: cleanTextValue(raw.matchedReason),
    matchedKeywords: Array.isArray(raw.matchedKeywords)
      ? raw.matchedKeywords.map(cleanTextValue).filter(Boolean)
      : [],
    notes: cleanTextValue(raw.notes),
  };
}

async function addScanLogs(entries) {
  if (!Array.isArray(entries) || !entries.length) return { added: 0, count: (await getScanLogs()).length };

  const logs = await getScanLogs();
  let added = 0;
  for (const raw of entries) {
    const entry = normalizeLogEntry(raw);
    if (!entry) continue;
    logs.unshift(entry);
    added += 1;
  }
  if (logs.length > MAX_SCAN_LOGS) logs.length = MAX_SCAN_LOGS;
  await storageSet({ [SCAN_LOGS_KEY]: logs });
  emitMessage({ type: "SCAN_LOGS_UPDATED", count: logs.length });
  return { added, count: logs.length };
}

async function addNeighborhoodRunLog(entry, options = {}) {
  if (!entry || typeof entry !== "object") return { added: 0, count: (await getScanLogs()).length };
  const completed = Math.max(0, Number(options.completedNeighborhoodCount || 0));
  const total = Math.max(0, Number(options.totalNeighborhoodCount || 0));
  const remaining = Math.max(0, total - completed);
  const reason = cleanTextValue(options.reason || "neighborhood_event");
  const label = cleanTextValue(entry.label || entry.neighborhood || "Neighborhood");
  const city = cleanTextValue(entry.city || "");
  const notes = [
    cleanTextValue(options.notes || ""),
    total ? `Completed ${completed} of ${total}` : "",
    total ? `Remaining ${remaining}` : "",
  ].filter(Boolean).join(" | ");

  return addScanLogs([{
    logId: `hood_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    scanLogKey: `neighborhood:${cleanTextValue(entry.url || label)}:${reason}:${completed}`,
    scannedAt: new Date().toISOString(),
    decision: "skipped",
    reason,
    reasonSource: "neighborhood_run",
    reasonDetail: cleanTextValue(options.reasonDetail || ""),
    captureStatus: "not_captured",
    saveReason: "",
    syncStatus: "not_applicable",
    syncReason: "",
    accountName: `[Neighborhood] ${label}`,
    subArea: city,
    postDateTime: "",
    postText: "",
    finalLink: cleanTextValue(entry.url || ""),
    profileLink: "",
    postLink: "",
    linkStatus: "",
    linkAttempts: 0,
    sourceMode: "neighborhood",
    pageUrl: cleanTextValue(entry.url || ""),
    accountArea: "",
    incogAccount: "",
    matchedReason: reason,
    matchedKeywords: [],
    notes,
  }]);
}

function pickTopReasonFromMap(reasonMap) {
  let topReason = "";
  let topCount = -1;
  for (const [reason, count] of Object.entries(reasonMap || {})) {
    const normalizedReason = cleanTextValue(reason || "");
    const normalizedCount = Number(count || 0);
    if (!normalizedReason) continue;
    if (normalizedCount > topCount) {
      topReason = normalizedReason;
      topCount = normalizedCount;
    }
  }
  return topReason;
}

async function updateScanLogs(updates) {
  if (!Array.isArray(updates) || !updates.length) return { updated: 0, count: (await getScanLogs()).length };

  const logs = await getScanLogs();
  let updated = 0;

  for (const raw of updates) {
    if (!raw || typeof raw !== "object") continue;
    const scanLogKey = cleanTextValue(raw.scanLogKey);
    const queueItemId = cleanTextValue(raw.queueItemId);
    if (!scanLogKey && !queueItemId) continue;

    const idx = logs.findIndex((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (queueItemId && cleanTextValue(entry.queueItemId) === queueItemId) return true;
      if (scanLogKey && cleanTextValue(entry.scanLogKey) === scanLogKey) return true;
      return false;
    });

    if (idx < 0) continue;

    logs[idx] = {
      ...logs[idx],
      queueItemId: queueItemId || cleanTextValue(logs[idx].queueItemId),
      captureStatus: cleanTextValue(raw.captureStatus || logs[idx].captureStatus),
      saveReason: cleanTextValue(raw.saveReason || logs[idx].saveReason),
      syncStatus: cleanTextValue(raw.syncStatus || logs[idx].syncStatus),
      syncReason: cleanTextValue(raw.syncReason || logs[idx].syncReason),
      syncedAt: cleanTextValue(raw.syncedAt || logs[idx].syncedAt),
      finalLink: cleanTextValue(raw.finalLink || logs[idx].finalLink),
      profileLink: cleanTextValue(raw.profileLink || logs[idx].profileLink),
      postLink: cleanTextValue(raw.postLink || logs[idx].postLink),
      linkStatus: cleanTextValue(raw.linkStatus || logs[idx].linkStatus),
      linkAttempts: Number(raw.linkAttempts || logs[idx].linkAttempts || 0),
      matchedReason: cleanTextValue(raw.matchedReason || logs[idx].matchedReason),
      notes: cleanTextValue(raw.notes || logs[idx].notes),
    };
    updated += 1;
  }

  if (updated) {
    await storageSet({ [SCAN_LOGS_KEY]: logs });
    emitMessage({ type: "SCAN_LOGS_UPDATED", count: logs.length });
  }

  return { updated, count: logs.length };
}

function isNextdoorPage(url) {
  try {
    const u = new URL(url || "");
    return /(^|\.)nextdoor\.com$/i.test(u.hostname || "");
  } catch {
    return false;
  }
}

async function queryNextdoorTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id && isNextdoorPage(tab.url || ""));
}

async function queryPrimaryNextdoorTabs(preferredTabId = 0) {
  const tabs = await queryNextdoorTabs();
  const preferredId = Number(preferredTabId || 0);
  const primary = tabs.find((tab) => Number(tab.id) === preferredId) || tabs.find((tab) => tab.active) || tabs[0] || null;
  return primary ? [primary] : [];
}

async function sendTabMessage(tabId, message, options) {
  try {
    const response = options
      ? await chrome.tabs.sendMessage(tabId, message, options)
      : await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch (err) {
    dwarn("sendTabMessage failed", { tabId, type: message && message.type, err: String(err) });
    return null;
  }
}

async function stopTabActivity(tabId) {
  if (!tabId) return;
  await ensureContentScript(tabId);
  await sendTabMessage(tabId, { type: "STOP_ACTIVITY" });
}

async function clearRunAlarms() {
  await clearAlarm(ALARM_AUTO_CYCLE);
  await clearAlarm(ALARM_RESUME_JOBS);
}

async function ensureContentScript(tabId) {
  try {
    const ping = await sendTabMessage(tabId, { type: "PING" });
    if (ping && ping.ok) return true;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    const ping2 = await sendTabMessage(tabId, { type: "PING" });
    return !!(ping2 && ping2.ok);
  } catch (err) {
    derror("ensureContentScript failed", { tabId, err: String(err) });
    return false;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === "complete") return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function ensureTabAtSource(tab, config, assignedSourceMode) {
  const tabId = tab.id;
  if (!tabId) return false;
  const currentUrl = String(tab.url || "");

  if (assignedSourceMode === "neighborhood") {
    const targetUrl = cleanTextValue(config.neighborhoodUrl || "");
    const expectedNeighborhood = normalizeNeighborhoodIdentity(config.neighborhoodName || "");
    const expectedCity = normalizeNeighborhoodIdentity(config.neighborhoodCity || config.city || "");
    if (!targetUrl) return false;
    if (currentUrl !== targetUrl) {
      dlog("[SOURCE] navigating tab to neighborhood url", { tabId, targetUrl });
      await chrome.tabs.update(tabId, { url: targetUrl });
      await waitForTabComplete(tabId);
    }

    await new Promise((resolve) => setTimeout(resolve, NEIGHBORHOOD_INITIAL_WAIT_MS));
    await ensureContentScript(tabId);
    let context = await sendTabMessage(tabId, { type: "GET_NEIGHBORHOOD_CONTEXT" });
    let currentNeighborhood = normalizeNeighborhoodIdentity(context && context.title);
    let currentCity = normalizeNeighborhoodIdentity((context && (context.cityName || context.city)) || "");
    if (
      expectedNeighborhood &&
      currentNeighborhood === expectedNeighborhood &&
      (!expectedCity || currentCity === expectedCity)
    ) {
      if (Number(context && context.postsThisWeek) === 0) {
        dwarn("[SOURCE] neighborhood has 0 posts this week, skipping", {
          tabId,
          expectedNeighborhood,
          expectedCity,
          title: context && context.title,
          city: context && (context.cityName || context.city),
        });
        return { ok: false, reason: "neighborhood_empty" };
      }
      dlog("[SOURCE] neighborhood verified", {
        tabId,
        expectedNeighborhood,
        expectedCity,
        title: context && context.title,
        city: context && (context.cityName || context.city),
        waitedMs: NEIGHBORHOOD_INITIAL_WAIT_MS,
      });
      return true;
    }
    dwarn("[SOURCE] neighborhood not ready after first 10 second wait", {
      tabId,
      expectedNeighborhood,
      expectedCity,
      currentTitle: context && context.title,
      currentCity: context && (context.cityName || context.city),
      targetUrl,
      waitedMs: NEIGHBORHOOD_INITIAL_WAIT_MS,
    });

    await new Promise((resolve) => setTimeout(resolve, NEIGHBORHOOD_SECOND_WAIT_MS));
    await ensureContentScript(tabId);
    context = await sendTabMessage(tabId, { type: "GET_NEIGHBORHOOD_CONTEXT" });
    currentNeighborhood = normalizeNeighborhoodIdentity(context && context.title);
    currentCity = normalizeNeighborhoodIdentity((context && (context.cityName || context.city)) || "");
    if (
      expectedNeighborhood &&
      currentNeighborhood === expectedNeighborhood &&
      (!expectedCity || currentCity === expectedCity)
    ) {
      if (Number(context && context.postsThisWeek) === 0) {
        dwarn("[SOURCE] neighborhood has 0 posts this week, skipping", {
          tabId,
          expectedNeighborhood,
          expectedCity,
          title: context && context.title,
          city: context && (context.cityName || context.city),
        });
        return { ok: false, reason: "neighborhood_empty" };
      }
      dlog("[SOURCE] neighborhood verified", {
        tabId,
        expectedNeighborhood,
        expectedCity,
        title: context && context.title,
        city: context && (context.cityName || context.city),
        waitedMs: NEIGHBORHOOD_INITIAL_WAIT_MS + NEIGHBORHOOD_SECOND_WAIT_MS,
      });
      return true;
    }
    dwarn("[SOURCE] neighborhood did not load within 20 seconds, skipping", {
      tabId,
      expectedNeighborhood,
      expectedCity,
      currentTitle: context && context.title,
      currentCity: context && (context.cityName || context.city),
      targetUrl,
      waitedMs: NEIGHBORHOOD_INITIAL_WAIT_MS + NEIGHBORHOOD_SECOND_WAIT_MS,
    });
    return false;
  }

  if (assignedSourceMode === "search") {
    const targetUrl = getEffectiveSearchUrl(config.searchUrl);
    if (!isValidNextdoorSearchUrl(currentUrl) || normalizeUrlForCompare(currentUrl) !== normalizeUrlForCompare(targetUrl)) {
      dlog("[SOURCE] navigating tab to search url", { tabId, targetUrl });
      try {
        await chrome.tabs.update(tabId, { url: targetUrl });
      } catch (err) {
        derror("[SOURCE] search navigation failed", { tabId, targetUrl, err: String(err) });
        return { ok: false, reason: "search_navigation_failed" };
      }
      await waitForTabComplete(tabId, 20000);
      const updatedTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!updatedTab || normalizeUrlForCompare(updatedTab.url) !== normalizeUrlForCompare(targetUrl)) {
        return { ok: false, reason: "search_navigation_incomplete" };
      }
    }
    return true;
  }

  const target = "https://nextdoor.com/news_feed/";
  if (isValidNextdoorSearchUrl(currentUrl)) {
    dlog("[SOURCE] navigating to news_feed", { tabId, target });
    await chrome.tabs.update(tabId, { url: target });
    await waitForTabComplete(tabId);
  }

  return true;
}

async function savePostsBatch(posts) {
  if (!Array.isArray(posts) || !posts.length) {
    return { added: 0, duplicate: 0, skippedMissingLink: 0 };
  }

  const currentPosts = await getPosts();
  const seen = new Set(await getSeen());

  let added = 0;
  let duplicate = 0;
  let skippedMissingLink = 0;
  const acceptedPosts = [];
  const logUpdates = [];

  for (const raw of posts) {
    if (!raw || typeof raw !== "object") continue;

    const post = {
      id: cleanTextValue(raw.id),
      accountName: cleanTextValue(raw.accountName || raw.author),
      author: cleanTextValue(raw.author || raw.accountName),
      profileLink: cleanTextValue(raw.profileLink),
      postLink: cleanTextValue(raw.postLink),
      finalLink: cleanTextValue(raw.finalLink || raw.profileLink || raw.postLink),
      subArea: cleanTextValue(raw.subArea || raw.neighborhood),
      neighborhood: cleanTextValue(raw.neighborhood || raw.subArea),
      postDateTime: cleanTextValue(raw.postDateTime || raw.timestampLabel),
      timestampLabel: cleanTextValue(raw.timestampLabel || raw.postDateTime),
      timestampIso: cleanTextValue(raw.timestampIso),
      timestampUnix: Number(raw.timestampUnix) || 0,
      postText: cleanTextValue(raw.postText || raw.text),
      text: cleanTextValue(raw.text || raw.postText),
      url: cleanTextValue(raw.url || raw.capturedFromUrl),
      capturedFromUrl: cleanTextValue(raw.capturedFromUrl || raw.url),
      incogAccount: cleanTextValue(raw.incogAccount),
      accountArea: cleanTextValue(raw.accountArea),
      matchedReason: cleanTextValue(raw.matchedReason),
      matchedKeywords: Array.isArray(raw.matchedKeywords)
        ? raw.matchedKeywords.map(cleanTextValue).filter(Boolean)
        : [],
      sourceMode: cleanTextValue(raw.sourceMode || ""),
      scrapedAt: cleanTextValue(raw.scrapedAt || raw.captureDateTime || new Date().toISOString()),
      captureDateTime: cleanTextValue(raw.captureDateTime || raw.scrapedAt || new Date().toISOString()),
      capturedDate: deriveCapturedDate(raw.capturedDate, raw.captureDateTime || raw.scrapedAt),
      capturedTime: deriveCapturedTime(raw.capturedTime, raw.captureDateTime || raw.scrapedAt),
      scanLogKey: cleanTextValue(raw.scanLogKey),
      queueItemId: cleanTextValue(
        raw.queueItemId || `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      ),
      linkStatus: cleanTextValue(
        raw.linkStatus || ((raw.finalLink || raw.profileLink || raw.postLink) ? "resolved" : "missing")
      ),
      missingLink: raw.missingLink === true || !(raw.finalLink || raw.profileLink || raw.postLink),
      linkAttempts: Number(raw.linkAttempts || 0),
    };

    if (post.missingLink) {
      skippedMissingLink++;
    }

    const dedupKeys = buildDedupKeys(post);
    if (dedupKeys.length && dedupKeys.some((key) => seen.has(key))) {
      duplicate++;
      logUpdates.push({
        scanLogKey: post.scanLogKey,
        queueItemId: post.queueItemId,
        captureStatus: "duplicate_blocked",
        saveReason: "duplicate_saved",
        syncStatus: "not_queued",
        syncReason: "duplicate_saved",
        finalLink: post.finalLink,
        profileLink: post.profileLink,
        postLink: post.postLink,
        linkStatus: post.linkStatus,
        linkAttempts: post.linkAttempts,
        matchedReason: post.matchedReason,
      });
      continue;
    }

    dedupKeys.forEach((key) => seen.add(key));

    currentPosts.unshift(post);
    acceptedPosts.push(post);
    logUpdates.push({
      scanLogKey: post.scanLogKey,
      queueItemId: post.queueItemId,
      captureStatus: post.missingLink ? "captured_missing_link" : "captured",
      saveReason: post.missingLink ? "missing_link_saved" : "queued_for_crm",
      syncStatus: "queued",
      syncReason: post.missingLink ? "queued_with_missing_link" : "waiting_for_crm",
      finalLink: post.finalLink,
      profileLink: post.profileLink,
      postLink: post.postLink,
      linkStatus: post.linkStatus,
      linkAttempts: post.linkAttempts,
      matchedReason: post.matchedReason,
    });
    added++;
  }

  if (currentPosts.length > MAX_POSTS) currentPosts.length = MAX_POSTS;

  await storageSet({
    [STORAGE_KEY]: currentPosts,
    [SEEN_KEY]: Array.from(seen).slice(-MAX_SEEN),
  });

  if (acceptedPosts.length) {
    await enqueueSheetsPosts(acceptedPosts);
  }
  if (logUpdates.length) {
    await updateScanLogs(logUpdates);
  }

  const stats = await getStats();
  stats.totalCaptured += added;
  stats.sessionCaptured += added;
  stats.totalDuplicates += duplicate;
  stats.sessionDuplicates += duplicate;

  if (skippedMissingLink > 0) {
    stats.preCaptureReasons.missing_link_saved =
      Number(stats.preCaptureReasons.missing_link_saved || 0) + skippedMissingLink;
  }

  await storageSet({ [STATS_KEY]: stats });
  emitMessage({ type: "POSTS_UPDATED", added, duplicate, posts: currentPosts, stats });

  return { added, duplicate, skippedMissingLink };
}

async function enqueueSheetsPosts(posts) {
  const { [SHEETS_QUEUE_KEY]: queue = [] } = await storageGet({ [SHEETS_QUEUE_KEY]: [] });
  const next = Array.isArray(queue) ? queue.slice() : [];
  for (const post of posts) next.push(post);
  dlog("[CRM] queue:enqueue", {
    added: Array.isArray(posts) ? posts.length : 0,
    previousQueueLength: Array.isArray(queue) ? queue.length : 0,
    nextQueueLength: next.length,
    sample: Array.isArray(posts) && posts.length ? getRowDebugSummary(posts[0]) : null,
  });
  await storageSet({ [SHEETS_QUEUE_KEY]: next });
  createAlarm(ALARM_SHEETS_FLUSH, FLUSH_INTERVAL_MS);
  emitMessage({ type: "SHEETS_QUEUE_UPDATED", queueCount: next.length });
  flushSheetsQueue().catch((err) => derror("immediate flushSheetsQueue failed", err));
}

async function getSheetsQueue() {
  const { [SHEETS_QUEUE_KEY]: queue = [] } = await storageGet({ [SHEETS_QUEUE_KEY]: [] });
  return Array.isArray(queue) ? queue : [];
}

async function setSheetsQueue(queue) {
  const list = Array.isArray(queue) ? queue : [];
  await storageSet({ [SHEETS_QUEUE_KEY]: list });
  emitMessage({ type: "SHEETS_QUEUE_UPDATED", queueCount: list.length });
}

async function removeFromSheetsQueue(identifierToRemove) {
  // Always re-read from storage before removing so rows added by
  // enqueueSheetsPosts while a flush is in progress are never clobbered.
  const { [SHEETS_QUEUE_KEY]: stored = [] } = await storageGet({ [SHEETS_QUEUE_KEY]: [] });
  const current = Array.isArray(stored) ? stored : [];
  const idx = current.findIndex(
    (row) => getQueueRowIdentifier(row) === identifierToRemove
  );
  if (idx >= 0) current.splice(idx, 1);
  await storageSet({ [SHEETS_QUEUE_KEY]: current });
  emitMessage({ type: "SHEETS_QUEUE_UPDATED", queueCount: current.length });
  return current;
}

async function removeManyFromSheetsQueue(identifiersToRemove) {
  const ids = new Set((Array.isArray(identifiersToRemove) ? identifiersToRemove : []).map(cleanTextValue).filter(Boolean));
  if (!ids.size) return getSheetsQueue();
  const { [SHEETS_QUEUE_KEY]: stored = [] } = await storageGet({ [SHEETS_QUEUE_KEY]: [] });
  const current = Array.isArray(stored) ? stored : [];
  const next = current.filter((row) => !ids.has(getQueueRowIdentifier(row)));
  await storageSet({ [SHEETS_QUEUE_KEY]: next });
  emitMessage({ type: "SHEETS_QUEUE_UPDATED", queueCount: next.length });
  return next;
}

function buildSheetsRowIdentifier(row) {
  const postId = cleanTextValue(row && (row.postId || row.id));
  const leadLink = cleanTextValue(row && (row.profileLink || row.postLink || row.finalLink));
  const accountName = cleanTextValue(row && row.accountName);
  const postDateTime = cleanTextValue(row && row.postDateTime);
  const postText = cleanTextValue(row && (row.postText || row.text));
  return postId || leadLink || `${accountName}|${postDateTime}|${normalizeDedupText(postText, 120)}`;
}

function getBatchSyncDelayMs(config) {
  const fromConfig = Number(config && config.perLeadSyncDelayMs);
  if (Number.isFinite(fromConfig) && fromConfig > 0) {
    return Math.min(60000, Math.max(1000, fromConfig));
  }
  return SHEETS_SYNC_BATCH_DELAY_MS;
}

async function flushSheetsQueue() {
  if (sheetsFlushInProgress) {
    dlog("[CRM] flush skipped because another flush is running");
    return;
  }

  const cooldownRemainingMs = Math.max(0, sheetsNextRetryAt - Date.now());
  if (cooldownRemainingMs > 0) {
    dlog("[CRM] flush postponed during retry cooldown", { cooldownRemainingMs });
    createAlarm(ALARM_SHEETS_FLUSH, cooldownRemainingMs);
    return;
  }

  sheetsFlushInProgress = true;
  dlog("[CRM] flush:start");

  try {
    const config = await getConfig();
    const webhookUrl = cleanTextValue(config.webhookUrl || "");
    dlog("[CRM] flush:config", {
      hasWebhookUrl: !!webhookUrl,
      webhookUrl: maskUrlForLog(webhookUrl),
      batchSize: SHEETS_SYNC_BATCH_SIZE,
    });

    if (!webhookUrl) {
      dwarn("No webhookUrl configured, postponing queue flush");
      createAlarm(ALARM_SHEETS_FLUSH, RETRY_FLUSH_INTERVAL_MS);
      return;
    }

    const batchDelayMs = getBatchSyncDelayMs(config);

    let queue = await getSheetsQueue();
    dlog("[CRM] flush:queue_loaded", {
      queueLength: queue.length,
      sample: queue.length ? getRowDebugSummary(queue[0]) : null,
    });
    if (!queue.length) return;

    let syncedThisRun = 0;
    let skippedThisRun = 0;
    const mergedSkippedReasons = {};
    let lastProcessedAt = "";

    while (queue.length) {
      const batch = queue.slice(0, SHEETS_SYNC_BATCH_SIZE);
      const validRows = [];
      const invalidRows = [];
      dlog("[CRM] flush:batch", {
        batchSize: batch.length,
        firstRow: batch.length ? getRowDebugSummary(batch[0]) : null,
      });

      for (const row of batch) {
        const rowText = cleanTextValue(row && (row.postText || row.text));
        if (!rowText) invalidRows.push(row);
        else validRows.push(row);
      }
      dlog("[CRM] flush:batch_validated", {
        validRows: validRows.length,
        invalidRows: invalidRows.length,
        invalidSamples: invalidRows.slice(0, 3).map(getRowDebugSummary),
      });

      if (invalidRows.length) {
        await updateScanLogs(invalidRows.map((row) => ({
          queueItemId: getQueueRowIdentifier(row),
          syncStatus: "failed",
          syncReason: "empty_text",
          syncedAt: new Date().toISOString(),
        })));
        skippedThisRun += invalidRows.length;
        mergedSkippedReasons.empty_text = Number(mergedSkippedReasons.empty_text || 0) + invalidRows.length;
        queue = await removeManyFromSheetsQueue(invalidRows.map((row) => getQueueRowIdentifier(row)));
        dwarn("[CRM] flush:dropped_empty_text_rows", {
          dropped: invalidRows.length,
          remainingQueueLength: queue.length,
        });
        if (!validRows.length) continue;
      }

      const data = await postWebhookJson(webhookUrl, {
        action: "append_rows",
        source: "account-boosters-nd-ext",
        sentAt: new Date().toISOString(),
        rows: validRows,
      });

      if (data.ok === false || String(data.status || "").toLowerCase() === "error") {
        derror("[CRM] append returned application error", data);
        throw new Error(cleanTextValue(data.reason || data.message || "append_failed"));
      }

      const skippedReasons = data && typeof data.skippedReasons === "object" ? data.skippedReasons : {};
      const addedNow = Math.max(0, Number(data.added || 0));
      const acceptedIds = new Set((Array.isArray(data.acceptedIds) ? data.acceptedIds : []).map(cleanTextValue).filter(Boolean));
      const skippedIds = new Set((Array.isArray(data.skippedIds) ? data.skippedIds : []).map(cleanTextValue).filter(Boolean));
      const sentQueueIds = validRows.map((row) => getQueueRowIdentifier(row));

      syncedThisRun += addedNow;
      skippedThisRun += Math.max(0, validRows.length - addedNow);

      for (const [reason, count] of Object.entries(skippedReasons)) {
        const key = cleanTextValue(reason || "unknown");
        if (!key) continue;
        mergedSkippedReasons[key] = Number(mergedSkippedReasons[key] || 0) + Number(count || 0);
      }

      const topSkippedReason = pickTopReasonFromMap(skippedReasons) || "sync_skipped";
      await updateScanLogs(validRows.map((row) => {
        const rowQueueId = getQueueRowIdentifier(row);
        const rowWebhookId = buildSheetsRowIdentifier(row);
        const wasAccepted = acceptedIds.size ? acceptedIds.has(rowWebhookId) : !skippedIds.has(rowWebhookId) && addedNow > 0;
        return {
          queueItemId: rowQueueId,
          syncStatus: wasAccepted ? "synced" : "failed",
          syncReason: wasAccepted ? "synced_to_crm" : topSkippedReason,
          syncedAt: new Date().toISOString(),
        };
      }));

      queue = await removeManyFromSheetsQueue(sentQueueIds);
      sheetsRetryAttempt = 0;
      sheetsNextRetryAt = 0;
      lastProcessedAt = new Date().toISOString();
      dlog("[CRM] flush:batch_done", {
        sent: validRows.length,
        addedNow,
        skippedNow: Math.max(0, validRows.length - addedNow),
        remainingQueueLength: queue.length,
        skippedReasons,
      });

      if (!queue.length) break;
      if (batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    const stats = await getStats();
    stats.totalSynced += syncedThisRun;
    stats.sessionSynced += syncedThisRun;
    stats.totalSkipped += skippedThisRun;
    stats.sessionSkipped += skippedThisRun;
    for (const [reason, count] of Object.entries(mergedSkippedReasons)) {
      const key = cleanTextValue(reason || "unknown");
      if (!key) continue;
      stats.skippedReasons[key] = Number(stats.skippedReasons[key] || 0) + Number(count || 0);
    }
    stats.lastSyncAt = lastProcessedAt || new Date().toISOString();
    stats.lastSyncStatus = "ok";
    await storageSet({ [STATS_KEY]: stats });
    emitMessage({ type: "STATS_UPDATED", stats });
    dlog("[CRM] flush:complete", {
      syncedThisRun,
      skippedThisRun,
      skippedReasons: mergedSkippedReasons,
    });
  } catch (err) {
    derror("flushSheetsQueue failed", err);
    const message = String(err && err.message || err);
    const rateLimited = !!(err && err.rateLimited) || /rate[\s_-]*limit|too many requests/i.test(message);
    const requestedDelayMs = Math.max(0, Number(err && err.retryAfterMs) || 0);
    sheetsRetryAttempt += 1;
    const retryBaseMs = rateLimited ? SHEETS_RATE_LIMIT_RETRY_MS : SHEETS_RETRY_BASE_MS;
    const exponentialDelayMs = retryBaseMs * (2 ** Math.min(4, sheetsRetryAttempt - 1));
    const retryDelayMs = Math.min(
      SHEETS_RETRY_MAX_MS,
      Math.max(retryBaseMs, requestedDelayMs, exponentialDelayMs)
    );
    sheetsNextRetryAt = Date.now() + retryDelayMs;
    const stats = await getStats();
    stats.lastSyncAt = new Date().toISOString();
    stats.lastSyncStatus = message;
    await storageSet({ [STATS_KEY]: stats });
    emitMessage({ type: "STATS_UPDATED", stats });
    createAlarm(ALARM_SHEETS_FLUSH, retryDelayMs);
    derror("[CRM] flush:failed_retry_scheduled", {
      error: message,
      httpStatus: Number(err && err.httpStatus) || 0,
      rateLimited,
      retryAttempt: sheetsRetryAttempt,
      retryInMs: retryDelayMs,
    });
  } finally {
    sheetsFlushInProgress = false;
    dlog("[CRM] flush:end");
  }
}

async function setAutoState(patch) {
  const { [AUTO_STATE_KEY]: state = {} } = await storageGet({ [AUTO_STATE_KEY]: {} });
  const next = { ...state, ...patch };
  await storageSet({ [AUTO_STATE_KEY]: next });
  emitMessage({ type: "AUTO_STATE_UPDATED", state: next });
  return next;
}

async function getAutoState() {
  const { [AUTO_STATE_KEY]: state = {} } = await storageGet({ [AUTO_STATE_KEY]: {} });
  return state || {};
}

async function stopAllTabs() {
  const tabs = await queryNextdoorTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    await stopTabActivity(tab.id);
  }
}

async function startScanOnTab(tabId, config, assignedSourceMode, scrollDurationMs) {
  if (!tabId) return { ok: false, error: "no_tab_id" };

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: "tab_missing" };

  const okScript = await ensureContentScript(tabId);
  if (!okScript) return { ok: false, error: "content_script_failed" };

  let atSource = null;
  try {
    atSource = await ensureTabAtSource(tab, config, assignedSourceMode);
  } catch (err) {
    derror("startScanOnTab navigation failed", { tabId, assignedSourceMode, err: String(err) });
    return { ok: false, error: "source_navigation_failed" };
  }
  if (!atSource || (typeof atSource === "object" && atSource.ok === false)) {
    const sourceReason = typeof atSource === "object" ? cleanTextValue(atSource.reason) : "source_not_ready";
    return {
      ok: false,
      error: assignedSourceMode === "neighborhood" ? (sourceReason || "neighborhood_not_ready") : (sourceReason || "source_not_ready"),
    };
  }

  const contentReady = await ensureContentScript(tabId);
  if (!contentReady) return { ok: false, error: "content_script_failed" };
  const startResponse = await sendTabMessage(tabId, {
    type: "START_ACTIVITY",
    config: {
      ...config,
      sourceMode: assignedSourceMode,
      neighborhoodPostLimit: Number(config.neighborhoodPostLimit || NEIGHBORHOOD_POST_LIMIT),
    },
  });
  if (!startResponse || startResponse.ok !== true) {
    return { ok: false, error: "content_start_failed" };
  }

  return { ok: true };
}

async function runCycleSegment(segment, config, segmentIndex = 0) {
  const autoState = await getAutoState();
  const tabs = await queryPrimaryNextdoorTabs(autoState.managedTabId);
  if (!tabs.length) {
    await setAutoState({
      running: false,
      phase: "idle",
      currentSourceMode: "",
      currentSourceLabel: "",
      currentSegmentIndex: 0,
      nextRunAt: 0,
      error: "no_nextdoor_tabs",
    });
    return { ok: false, error: "no_nextdoor_tabs" };
  }

  const runDeadlineAt = Number(autoState.runDeadlineAt || 0);
  const loadingStartedAt = Date.now();
  await setAutoState({
    running: true,
    paused: false,
    mode: "auto",
    phase: "loading",
    currentSourceMode: segment.sourceMode,
    currentSourceLabel: segment.label,
    currentSegmentIndex: Math.max(0, Number(segmentIndex) || 0),
    managedTabId: Number(tabs[0] && tabs[0].id) || Number(autoState.managedTabId || 0),
    startedAt: loadingStartedAt,
    nextRunAt: 0,
    runDeadlineAt,
    error: "",
  });

  let startError = "";
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (!tab.id) continue;
    const runConfig = segment.searchUrl ? { ...config, searchUrl: segment.searchUrl } : config;
    const result = await startScanOnTab(tab.id, runConfig, segment.sourceMode, segment.durationMs);
    if (!result || result.ok !== true) {
      startError = cleanTextValue(result && result.error) || "segment_start_failed";
      break;
    }
  }

  if (startError) {
    const advanceDelayMs = 3000;
    await stopAllTabs();
    await setAutoState({
      running: true,
      paused: false,
      mode: "auto",
      phase: "transition_error",
      currentSourceMode: segment.sourceMode,
      currentSourceLabel: segment.label,
      currentSegmentIndex: Math.max(0, Number(segmentIndex) || 0),
      nextRunAt: Date.now() + advanceDelayMs,
      runDeadlineAt,
      error: startError,
    });
    createAlarm(ALARM_AUTO_CYCLE, advanceDelayMs);
    return { ok: true, skipped: true, error: startError };
  }

  const activeStartedAt = Date.now();
  if (runDeadlineAt && runDeadlineAt <= activeStartedAt) {
    await stopAutoCycle();
    return { ok: false, error: "run_deadline" };
  }
  const durationMs = runDeadlineAt
    ? Math.max(1000, Math.min(segment.durationMs, runDeadlineAt - activeStartedAt))
    : segment.durationMs;
  await setAutoState({
    running: true,
    paused: false,
    mode: "auto",
    phase: "scroll",
    currentSourceMode: segment.sourceMode,
    currentSourceLabel: segment.label,
    currentSegmentIndex: Math.max(0, Number(segmentIndex) || 0),
    startedAt: activeStartedAt,
    nextRunAt: activeStartedAt + durationMs,
    runDeadlineAt,
    error: "",
  });
  createAlarm(ALARM_AUTO_CYCLE, durationMs);
  return { ok: true };
}

async function getScanProgressFromTab(tabId) {
  if (!tabId) return null;
  await ensureContentScript(tabId);
  return await sendTabMessage(tabId, { type: "GET_SCAN_PROGRESS" });
}

async function runNeighborhoodEntry(tabId, config, entry, index, total, runDeadlineAt = 0) {
  const startedAt = Date.now();
  const neighborhoodBudgetMs = NEIGHBORHOOD_INITIAL_WAIT_MS + NEIGHBORHOOD_SECOND_WAIT_MS + NEIGHBORHOOD_SCAN_WINDOW_MS + 3000;
  const boundedDurationMs = runDeadlineAt
    ? Math.max(1000, Math.min(neighborhoodBudgetMs, runDeadlineAt - startedAt))
    : neighborhoodBudgetMs;

  await setAutoState({
    running: true,
    mode: "neighborhood",
    phase: "scroll",
    currentSourceMode: "neighborhood",
    currentSourceLabel: entry.label,
    currentNeighborhoodIndex: index,
    currentNeighborhoodTotal: total,
    currentNeighborhoodUrl: entry.url,
    startedAt,
    nextRunAt: startedAt + boundedDurationMs,
    runDeadlineAt,
  });

  const runConfig = {
    ...config,
    neighborhoodUrl: entry.url,
    neighborhoodName: entry.neighborhood,
    neighborhoodCity: entry.city,
    neighborhoodPostLimit: NEIGHBORHOOD_POST_LIMIT,
  };

  const startResult = await startScanOnTab(tabId, runConfig, "neighborhood", boundedDurationMs);
  if (!startResult || startResult.ok !== true) return startResult || { ok: false, error: "start_failed" };

  const scanStartedAt = Date.now();
  const scanWindowMs = runDeadlineAt
    ? Math.max(1000, Math.min(NEIGHBORHOOD_SCAN_WINDOW_MS, runDeadlineAt - scanStartedAt))
    : NEIGHBORHOOD_SCAN_WINDOW_MS;
  let retriedFeedError = false;
  let feedRecoveryGraceUntil = 0;

  while (Date.now() - scanStartedAt < scanWindowMs) {
    await new Promise((resolve) => setTimeout(resolve, NEIGHBORHOOD_PROGRESS_POLL_MS));

    const autoState = await getAutoState();
    if (!autoState || !autoState.running) {
      return { ok: false, error: "stopped" };
    }

    const progress = await getScanProgressFromTab(tabId);
    const loadedCount = Math.max(0, Number(progress && progress.loadedCount) || 0);
    const processedCount = Math.max(0, Number(progress && progress.processedCount) || 0);
    const acceptedCount = Math.max(0, Number(progress && progress.acceptedCount) || 0);
    const targetCount = Math.max(1, Number(progress && progress.targetCount) || NEIGHBORHOOD_POST_LIMIT);
    const limitReached = !!(progress && progress.limitReached);
    const feedErrorVisible = !!(progress && progress.feedErrorVisible);
    const feedRetryAvailable = !!(progress && progress.feedRetryAvailable);

    if (feedErrorVisible) {
      if (!retriedFeedError && feedRetryAvailable) {
        retriedFeedError = true;
        dlog("[NEIGHBORHOOD] feed error detected, clicking Try again once", {
          index,
          total,
          url: entry && entry.url,
          label: entry && entry.label,
        });
        await sendTabMessage(tabId, { type: "HANDLE_NEIGHBORHOOD_FEED_ERROR" });
        await new Promise((resolve) => setTimeout(resolve, NEIGHBORHOOD_FEED_RETRY_WAIT_MS));
        feedRecoveryGraceUntil = Date.now() + NEIGHBORHOOD_FEED_RECOVERY_GRACE_MS;
        continue;
      }
      if (feedRecoveryGraceUntil > Date.now()) {
        continue;
      }
      return { ok: false, error: "neighborhood_feed_error" };
    }

    if (limitReached || (loadedCount >= targetCount && processedCount >= targetCount)) {
      return {
        ok: true,
        completed: true,
        reason: acceptedCount > 0 ? "target_reached" : "no_matching_post_found",
        acceptedCount,
        loadedCount,
        processedCount,
      };
    }
  }

  const finalProgress = await getScanProgressFromTab(tabId);
  const finalAcceptedCount = Math.max(0, Number(finalProgress && finalProgress.acceptedCount) || 0);
  return {
    ok: true,
    completed: true,
    reason: finalAcceptedCount > 0 ? "scan_window_elapsed" : "no_matching_post_found",
    acceptedCount: finalAcceptedCount,
    loadedCount: Math.max(0, Number(finalProgress && finalProgress.loadedCount) || 0),
    processedCount: Math.max(0, Number(finalProgress && finalProgress.processedCount) || 0),
  };
}

async function startNeighborhoodRun(resetSession = false, startIndex = 0) {
  const config = await getConfig();
  await clearRunAlarms();
  if (!hasActiveFilters(config)) return { ok: false, error: "no_filters_enabled" };
  if (!hasNeighborhoodTargets(config)) return { ok: false, error: "no_neighborhood_targets" };

  const targets = parseNeighborhoodTargets(config);
  if (!targets.length) return { ok: false, error: "invalid_neighborhood_targets" };

  if (resetSession) {
    await resetSessionStats();
  }

  const previousState = await getAutoState();
  const runDeadlineAt = getRunDeadlineAt(config, previousState.runDeadlineAt, resetSession);

  const tabs = await queryNextdoorTabs();
  const tab = tabs.find((item) => item && item.id) || null;
  if (!tab || !tab.id) {
    await setAutoState({
      running: false,
      phase: "idle",
      currentSourceMode: "",
      currentSourceLabel: "",
      nextRunAt: 0,
      error: "no_nextdoor_tabs",
    });
    return { ok: false, error: "no_nextdoor_tabs" };
  }

  const stats = await getStats();
  if (resetSession) {
    stats.cycleCount += 1;
    stats.cycling = true;
    await storageSet({ [STATS_KEY]: stats });
    emitMessage({ type: "STATS_UPDATED", stats });
  }

  for (let i = Math.max(0, Number(startIndex || 0)); i < targets.length; i++) {
    if (runDeadlineAt && runDeadlineAt <= Date.now()) {
      await stopAutoCycle();
      return { ok: true, completed: false, reason: "run_deadline" };
    }

    const result = await runNeighborhoodEntry(tab.id, config, targets[i], i, targets.length, runDeadlineAt);
    await stopTabActivity(tab.id);

    if (!result || result.ok !== true) {
      if (["neighborhood_not_ready", "neighborhood_empty"].includes(cleanTextValue(result && result.error))) {
        await addNeighborhoodRunLog(targets[i], {
          reason: cleanTextValue(result && result.error),
          completedNeighborhoodCount: i,
          totalNeighborhoodCount: targets.length,
          notes: cleanTextValue(result && result.error) === "neighborhood_empty"
            ? "Page shows 0 posts this week."
            : "Neighborhood title/city did not match within 20 seconds.",
        });
        dwarn("[NEIGHBORHOOD] target did not finish loading in time, skipping", {
          index: i,
          total: targets.length,
          url: targets[i] && targets[i].url,
          label: targets[i] && targets[i].label,
          reason: cleanTextValue(result && result.error),
        });
        continue;
      }
      if (cleanTextValue(result && result.error) === "stopped") return { ok: true, completed: false, reason: "stopped" };
      if (cleanTextValue(result && result.error) === "neighborhood_feed_error") {
        await addNeighborhoodRunLog(targets[i], {
          reason: "neighborhood_feed_error",
          completedNeighborhoodCount: i,
          totalNeighborhoodCount: targets.length,
          notes: "Feed error persisted after one Try again attempt. Run stopped.",
        });
        await clearRunAlarms();
        await stopAllTabs();
        const nextStats = await getStats();
        nextStats.cycling = false;
        await storageSet({ [STATS_KEY]: nextStats });
        emitMessage({ type: "STATS_UPDATED", stats: nextStats });
        await setAutoState({
          running: false,
          mode: "neighborhood",
          phase: "idle",
          currentSourceMode: "neighborhood",
          currentSourceLabel: targets[i] && targets[i].label,
          currentNeighborhoodIndex: i,
          currentNeighborhoodTotal: targets.length,
          currentNeighborhoodUrl: targets[i] && targets[i].url,
          completedNeighborhoodCount: i,
          nextRunAt: 0,
          error: "neighborhood_feed_error",
        });
        return result;
      }
      await setAutoState({
        running: false,
        phase: "idle",
        currentSourceMode: "",
        currentSourceLabel: "",
        currentSegmentIndex: 0,
        nextRunAt: 0,
        error: cleanTextValue(result && result.error) || "neighborhood_run_failed",
      });
      return result || { ok: false, error: "neighborhood_run_failed" };
    }

    if (cleanTextValue(result && result.reason) === "no_matching_post_found") {
      await addNeighborhoodRunLog(targets[i], {
        reason: "no_matching_post_found",
        completedNeighborhoodCount: i + 1,
        totalNeighborhoodCount: targets.length,
        notes: `Loaded ${Number(result.loadedCount || 0)} cards, processed ${Number(result.processedCount || 0)}, matched 0 leads.`,
      });
      continue;
    }
  }

  await stopAutoCycle();
  return { ok: true, completed: true };
}

async function continueAutoCycle() {
  const config = await getConfig();
  if (String(config.sourceMode || "").toLowerCase() === "neighborhood") {
    return startNeighborhoodRun(false, Number((await getAutoState()).currentNeighborhoodIndex || 0));
  }
  const autoState = await getAutoState();
  if (!autoState || !autoState.running || autoState.paused) return { ok: false, error: "not_running" };
  const runDeadlineAt = Number(autoState.runDeadlineAt || 0);
  if (runDeadlineAt && runDeadlineAt <= Date.now()) {
    await stopAutoCycle();
    return;
  }
  const segments = getCycleSegments(config);
  const currentSource = String(autoState.currentSourceMode || "").toLowerCase();
  const savedIndex = Number(autoState.currentSegmentIndex);
  const currentIndex = Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < segments.length
    ? savedIndex
    : segments.findIndex((s) => s.sourceMode === currentSource);
  const nextIndex = currentIndex + 1;

  if (nextIndex < segments.length) {
    await stopAllTabs();
    await runCycleSegment(segments[nextIndex], config, nextIndex);
    return;
  }

  const isSearchRotation =
    ["search", "both"].includes(String(config.sourceMode || "").toLowerCase()) &&
    String(config.searchPlanMode || "rotation").toLowerCase() === "rotation";
  if (isSearchRotation) {
    await stopAutoCycle();
    return { ok: true, completed: true };
  }

  const restMinutes = Math.max(0, Number(config.restMinutes || 0));
  const restMs = restMinutes * 60 * 1000;
  if (restMs > 0) {
    const boundedRestMs = runDeadlineAt
      ? Math.max(0, Math.min(restMs, runDeadlineAt - Date.now()))
      : restMs;
    if (runDeadlineAt && boundedRestMs <= 0) {
      await stopAutoCycle();
      return;
    }
    await stopAllTabs();
    await setAutoState({
      running: true,
      mode: "auto",
      phase: "rest",
      currentSourceMode: "",
      currentSourceLabel: "",
      currentSegmentIndex: 0,
      nextRunAt: Date.now() + boundedRestMs,
      runDeadlineAt,
    });
    createAlarm(ALARM_AUTO_CYCLE, boundedRestMs);
    return;
  }

  await startAutoCycle(false);
}

async function startAutoCycle(resetSession = false) {
  const config = await getConfig();
  if (!hasActiveFilters(config)) {
    return { ok: false, error: "no_filters_enabled" };
  }
  if (String(config.sourceMode || "").toLowerCase() === "neighborhood") {
    return startNeighborhoodRun(resetSession, 0);
  }
  if (resetSession) {
    await resetSessionStats();
  }
  const previousState = await getAutoState();
  const runDeadlineAt = getRunDeadlineAt(config, previousState.runDeadlineAt, resetSession);
  await setAutoState({ runDeadlineAt, mode: "auto", paused: false, error: "" });
  const segments = getCycleSegments(config);
  const first = segments[0];

  const stats = await getStats();
  stats.cycleCount += 1;
  stats.cycling = true;
  await storageSet({ [STATS_KEY]: stats });
  emitMessage({ type: "STATS_UPDATED", stats });

  const result = await runCycleSegment(first, config, 0);
  return result && result.ok === false ? result : { ok: true };
}

async function stopAutoCycle() {
  await clearRunAlarms();
  await stopAllTabs();

  const stats = await getStats();
  stats.cycling = false;
  await storageSet({ [STATS_KEY]: stats });
  emitMessage({ type: "STATS_UPDATED", stats });

  await setAutoState({
    running: false,
    paused: false,
    phase: "idle",
    currentSourceMode: "",
    currentSourceLabel: "",
    currentSegmentIndex: 0,
    managedTabId: 0,
    nextRunAt: 0,
    runDeadlineAt: 0,
    currentNeighborhoodIndex: 0,
    currentNeighborhoodTotal: 0,
    currentNeighborhoodUrl: "",
  });
}

async function startManualRun(tabId) {
  const config = await getConfig();
  if (!hasActiveFilters(config)) return { ok: false, error: "no_filters_enabled" };
  if (String(config.sourceMode || "").toLowerCase() === "neighborhood") {
    return startNeighborhoodRun(true, 0);
  }
  await resetSessionStats();
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const targetTabs = tab ? [tab] : await queryNextdoorTabs();
  if (!targetTabs.length) return { ok: false, error: "no_nextdoor_tabs" };

  const assignedSourceMode = String(config.sourceMode || "recent").toLowerCase() === "search" ? "search" : "recent";
  const isSingleSearch = assignedSourceMode === "search" && String(config.searchPlanMode || "rotation").toLowerCase() === "single";
  const runDurationMs = (isSingleSearch
    ? Math.max(1, Number(config.singleSearchMinutes || 15))
    : Math.max(1, Number(config.scrollMinutes || 15))) * 60 * 1000;
  const runConfig = isSingleSearch
    ? {
        ...config,
        searchUrl: buildSingleKeywordSearchUrl(config.singleSearchKeyword || "handyman"),
      }
    : config;
  for (const t of targetTabs) {
    if (!t.id) continue;
    await startScanOnTab(t.id, runConfig, assignedSourceMode, runDurationMs);
  }

  await setAutoState({
    running: true,
    mode: "manual",
    phase: "scroll",
    currentSourceMode: assignedSourceMode,
    currentSourceLabel: isSingleSearch ? `Search: ${cleanTextValue(config.singleSearchKeyword || "handyman")}` : assignedSourceMode === "search" ? "Search" : "Recent",
    startedAt: Date.now(),
    nextRunAt: Date.now() + runDurationMs,
    runDeadlineAt: 0,
  });
  createAlarm(ALARM_AUTO_CYCLE, runDurationMs);

  return { ok: true };
}

async function stopManualRun() {
  await clearRunAlarms();
  await stopAllTabs();
  await setAutoState({
    running: false,
    paused: false,
    mode: "manual",
    phase: "idle",
    currentSourceMode: "",
    currentSourceLabel: "",
    currentSegmentIndex: 0,
    nextRunAt: 0,
    runDeadlineAt: 0,
  });
  return { ok: true };
}

async function stopAllRunsNow() {
  await clearRunAlarms();
  await stopAllTabs();

  const stats = await getStats();
  stats.cycling = false;
  await storageSet({ [STATS_KEY]: stats });
  emitMessage({ type: "STATS_UPDATED", stats });

  await setAutoState({
    running: false,
    paused: false,
    mode: "",
    phase: "idle",
    currentSourceMode: "",
    currentSourceLabel: "",
    currentSegmentIndex: 0,
    currentNeighborhoodIndex: 0,
    currentNeighborhoodTotal: 0,
    currentNeighborhoodUrl: "",
    nextRunAt: 0,
    startedAt: 0,
    runDeadlineAt: 0,
    pausedFromPhase: "",
    pausedRemainingMs: 0,
    pausedRunDeadlineRemainingMs: 0,
    managedTabId: 0,
    error: "",
  });

  return { ok: true };
}

async function pauseActiveRunNow() {
  const autoState = await getAutoState();
  if (!autoState || !autoState.running) {
    return autoState && autoState.paused ? { ok: true, paused: true } : { ok: false, error: "not_running" };
  }

  const now = Date.now();
  await clearRunAlarms();
  await stopAllTabs();

  const stats = await getStats();
  stats.cycling = false;
  await storageSet({ [STATS_KEY]: stats });
  emitMessage({ type: "STATS_UPDATED", stats });

  await setAutoState({
    running: false,
    paused: true,
    phase: "paused",
    pausedFromPhase: cleanTextValue(autoState.phase || "scroll") || "scroll",
    pausedRemainingMs: Math.max(0, Number(autoState.nextRunAt || 0) - now),
    pausedRunDeadlineRemainingMs: Number(autoState.runDeadlineAt || 0)
      ? Math.max(0, Number(autoState.runDeadlineAt) - now)
      : 0,
    nextRunAt: 0,
    runDeadlineAt: 0,
    error: "",
  });
  return { ok: true, paused: true };
}

async function continuePausedRunNow() {
  const autoState = await getAutoState();
  if (!autoState || !autoState.paused) return { ok: false, error: "not_paused" };

  const config = await getConfig();
  if (!hasActiveFilters(config)) return { ok: false, error: "no_filters_enabled" };

  const deadlineRemainingMs = Math.max(0, Number(autoState.pausedRunDeadlineRemainingMs || 0));
  const runDeadlineAt = deadlineRemainingMs ? Date.now() + deadlineRemainingMs : 0;
  const remainingMs = Math.max(0, Number(autoState.pausedRemainingMs || 0));

  const stats = await getStats();
  stats.cycling = true;
  await storageSet({ [STATS_KEY]: stats });
  emitMessage({ type: "STATS_UPDATED", stats });

  if (autoState.pausedFromPhase === "rest") {
    const restMs = Math.max(1000, remainingMs || Number(config.restMinutes || 0) * 60 * 1000);
    await setAutoState({
      running: true,
      paused: false,
      phase: "rest",
      nextRunAt: Date.now() + restMs,
      runDeadlineAt,
      error: "",
    });
    createAlarm(ALARM_AUTO_CYCLE, restMs);
    return { ok: true, continued: true };
  }

  if (autoState.mode === "neighborhood" || String(config.sourceMode || "").toLowerCase() === "neighborhood") {
    await setAutoState({ running: true, paused: false, runDeadlineAt, error: "" });
    return startNeighborhoodRun(false, Number(autoState.currentNeighborhoodIndex || 0));
  }

  const segments = getCycleSegments(config);
  const savedIndex = Number(autoState.currentSegmentIndex || 0);
  const segmentIndex = Math.max(0, Math.min(segments.length - 1, savedIndex));
  const segment = segments[segmentIndex] || segments[0];
  if (!segment) return { ok: false, error: "no_cycle_segments" };

  await setAutoState({ running: true, paused: false, runDeadlineAt, error: "" });
  return runCycleSegment(
    { ...segment, durationMs: Math.max(1000, remainingMs || segment.durationMs) },
    config,
    segmentIndex
  );
}

async function restartActiveRunNow(tabId) {
  const config = await getConfig();
  if (!hasActiveFilters(config)) return { ok: false, error: "no_filters_enabled" };
  const activeTab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const targetTabs = activeTab ? [activeTab] : await queryNextdoorTabs();
  if (!targetTabs.length) return { ok: false, error: "no_nextdoor_tabs" };

  await stopAllRunsNow();

  return startAutoCycle(true);
}

async function resumeSavedRun() {
  const autoState = await getAutoState();
  if (!autoState || !autoState.running) return { ok: false, error: "not_running" };

  const config = await getConfig();
  if (!hasActiveFilters(config)) {
    await stopAllRunsNow();
    return { ok: false, error: "no_filters_enabled" };
  }
  if (autoState.mode === "neighborhood" || String(config.sourceMode || "").toLowerCase() === "neighborhood") {
    return startNeighborhoodRun(false, Number(autoState.currentNeighborhoodIndex || 0));
  }

  if (autoState.mode === "manual") {
    const targetTabs = await queryNextdoorTabs();
    if (!targetTabs.length) return { ok: false, error: "no_nextdoor_tabs" };
    const assignedSourceMode = String(autoState.currentSourceMode || config.sourceMode || "recent").toLowerCase() === "search" ? "search" : "recent";
    const remainingMs = Number(autoState.nextRunAt || 0) - Date.now();
    if (remainingMs <= 0) {
      await stopManualRun();
      return { ok: true };
    }
    const durationMs = Math.max(15000, remainingMs);
    const isSingleSearch = assignedSourceMode === "search" && String(config.searchPlanMode || "rotation").toLowerCase() === "single";
    const runConfig = isSingleSearch
      ? {
          ...config,
          searchUrl: buildSingleKeywordSearchUrl(config.singleSearchKeyword || "handyman"),
        }
      : config;
    for (const t of targetTabs) {
      if (!t.id) continue;
      await startScanOnTab(t.id, runConfig, assignedSourceMode, durationMs);
    }
    await setAutoState({
      running: true,
      mode: "manual",
      phase: "scroll",
      currentSourceMode: assignedSourceMode,
      currentSourceLabel: isSingleSearch ? `Search: ${cleanTextValue(config.singleSearchKeyword || "handyman")}` : assignedSourceMode === "search" ? "Search" : "Recent",
      startedAt: Number(autoState.startedAt || Date.now()),
      nextRunAt: Date.now() + durationMs,
      runDeadlineAt: 0,
    });
    return { ok: true };
  }

  if (autoState.phase === "rest") {
    const remainingMs = Math.max(0, Number(autoState.nextRunAt || 0) - Date.now());
    if (remainingMs > 0) {
      createAlarm(ALARM_AUTO_CYCLE, remainingMs);
      await setAutoState({
        running: true,
        mode: "auto",
        phase: "rest",
        nextRunAt: Date.now() + remainingMs,
        runDeadlineAt: Number(autoState.runDeadlineAt || 0),
      });
      return { ok: true };
    }
    return startAutoCycle(false);
  }

  const segments = getCycleSegments(config);
  const sourceMode = String(autoState.currentSourceMode || "").toLowerCase();
  const savedIndex = Number(autoState.currentSegmentIndex);
  const segmentIndex = Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < segments.length
    ? savedIndex
    : Math.max(0, segments.findIndex((entry) => entry.sourceMode === sourceMode));
  const segment = segments[segmentIndex] || segments[0];
  const rawRemainingMs = Number(autoState.nextRunAt || 0) - Date.now();
  if (rawRemainingMs <= 0) {
    await continueAutoCycle();
    return { ok: true };
  }
  const remainingMs = Math.max(15000, rawRemainingMs);
  await runCycleSegment({ ...segment, durationMs: remainingMs }, config, segmentIndex);
  return { ok: true };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (!alarm || !alarm.name) return;
    if (alarm.name === ALARM_SHEETS_FLUSH) {
      await flushSheetsQueue();
      return;
    }
    if (alarm.name === ALARM_AUTO_CYCLE) {
      await withRunControl(async () => {
        const autoState = await getAutoState();
        if (!autoState || !autoState.running || autoState.paused) {
          await clearAlarm(ALARM_AUTO_CYCLE);
          return;
        }
        if (autoState.mode === "manual") {
          await stopManualRun();
          return;
        }
        if (autoState.mode === "neighborhood") {
          await startNeighborhoodRun(false, Number(autoState.currentNeighborhoodIndex || 0));
          return;
        }
        if (autoState.phase === "rest") {
          await startAutoCycle(false);
          return;
        }
        await continueAutoCycle();
      });
      return;
    }
    if (alarm.name === ALARM_RESUME_JOBS) {
      await clearAlarm(ALARM_RESUME_JOBS);
    }
  } catch (err) {
    derror("alarm failed", err);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  await storageSet({
    [CONFIG_KEY]: {
      ...config,
      configRevision: CONFIG_REVISION,
      sourceMode: "search",
      searchUrl: DEFAULT_SEARCH_URL,
      searchPlanMode: "rotation",
      singleSearchKeyword: cleanTextValue(config.singleSearchKeyword || "handyman") || "handyman",
      singleSearchMinutes: Math.max(1, Number(config.singleSearchMinutes || 15)),
      scrollMinutes: 15,
      restMinutes: 0,
      scrollDelayMs: Number(config.scrollDelayMs || 1000),
      timeRangeHours: Number(config.timeRangeHours || 24),
      keywords: DEFAULT_INCLUDE_KEYWORDS,
      excludeKeywords: Array.isArray(config.excludeKeywords) && config.excludeKeywords.length
        ? config.excludeKeywords
        : DEFAULT_EXCLUDE_KEYWORDS,
      webhookUrl: cleanTextValue(config.webhookUrl || DEFAULT_WEBHOOK_URL),
      incogAccountName: cleanTextValue(config.incogAccountName || ""),
      accountArea: cleanTextValue(config.accountArea || ""),
      useSmartMatch: !!config.useSmartMatch,
      perLeadSyncDelayMs: Number(config.perLeadSyncDelayMs || 0),
    },
  });
  await stopAllRunsNow();
});

chrome.runtime.onStartup.addListener(async () => {
  const queue = await getSheetsQueue();
  if (queue.length) createAlarm(ALARM_SHEETS_FLUSH, FLUSH_INTERVAL_MS);
  await clearAlarm(ALARM_RESUME_JOBS);
  const autoState = await getAutoState();
  if (autoState && autoState.running) {
    await withRunControl(() => resumeSavedRun());
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const type = cleanTextValue(message && message.type);

    if (type === "SAVE_POSTS") {
      const result = await savePostsBatch(Array.isArray(message.posts) ? message.posts : []);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (type === "SCAN_DIAGNOSTICS") {
      const stats = await getStats();
      const patch = message && message.diagnostics ? message.diagnostics : {};
      const mergedReasons = { ...(stats.scanDiagnostics && stats.scanDiagnostics.reasons || {}) };
      for (const [k, v] of Object.entries((patch && patch.reasons) || {})) {
        mergedReasons[k] = (mergedReasons[k] || 0) + Number(v || 0);
      }
      stats.scanDiagnostics = {
        scanned: Number(stats.scanDiagnostics.scanned || 0) + Number(patch.scanned || 0),
        accepted: Number(stats.scanDiagnostics.accepted || 0) + Number(patch.accepted || 0),
        rejected: Number(stats.scanDiagnostics.rejected || 0) + Number(patch.rejected || 0),
        reasons: mergedReasons,
      };
      await storageSet({ [STATS_KEY]: stats });
      emitMessage({ type: "STATS_UPDATED", stats });
      sendResponse({ ok: true });
      return;
    }

    if (type === "ADD_SCAN_LOGS") {
      const result = await addScanLogs(Array.isArray(message.logs) ? message.logs : []);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (type === "GET_STATS") {
      const stats = await getStats();
      sendResponse({ ok: true, stats });
      return;
    }

    if (type === "GET_POSTS") {
      const posts = await getPosts();
      sendResponse({ ok: true, posts });
      return;
    }

    if (type === "GET_SCAN_LOGS") {
      const logs = await getScanLogs();
      sendResponse({ ok: true, logs });
      return;
    }

    if (type === "CLEAR_POSTS") {
      await stopAllRunsNow();
      sheetsRetryAttempt = 0;
      sheetsNextRetryAt = 0;
      await clearAlarm(ALARM_SHEETS_FLUSH);
      await storageSet({
        [STORAGE_KEY]: [],
        [SEEN_KEY]: [],
        [SCAN_LOGS_KEY]: [],
        [SHEETS_QUEUE_KEY]: [],
        [STATS_KEY]: getEmptyStats(),
      });
      emitMessage({ type: "POSTS_UPDATED", added: 0, duplicate: 0, posts: [], stats: getEmptyStats() });
      emitMessage({ type: "SHEETS_QUEUE_UPDATED", queueCount: 0 });
      emitMessage({ type: "SCAN_LOGS_UPDATED", count: 0 });
      emitMessage({ type: "STATS_UPDATED", stats: getEmptyStats() });
      sendResponse({ ok: true });
      return;
    }

    if (type === "CLEAR_SCAN_LOGS") {
      await storageSet({ [SCAN_LOGS_KEY]: [] });
      emitMessage({ type: "SCAN_LOGS_UPDATED", count: 0 });
      sendResponse({ ok: true });
      return;
    }

    if (type === "GET_QUEUE") {
      const queue = await getSheetsQueue();
      sendResponse({ ok: true, queue });
      return;
    }

    if (type === "GET_CONFIG") {
      const config = await getConfig();
      sendResponse({ ok: true, config });
      return;
    }

    if (type === "SET_CONFIG" || type === "SAVE_CONFIG") {
      const current = await getConfig();
      const next = {
        ...current,
        ...(message.config || {}),
      };
      next.searchUrl = getEffectiveSearchUrl(next.searchUrl);
      await storageSet({ [CONFIG_KEY]: next });
      sendResponse({ ok: true, config: next });
      return;
    }

    if (type === "TEST_WEBHOOK") {
      const url = cleanTextValue((message && message.url) || "");
      if (!url) {
        sendResponse({ ok: false, error: "missing_webhook_url" });
        return;
      }
      const data = await postWebhookJson(url, { action: "test_connection" });
      if (data && (data.ok === true || String(data.status || "").toLowerCase() === "ok")) {
        sheetsRetryAttempt = 0;
        sheetsNextRetryAt = 0;
        const stats = await getStats();
        stats.lastSyncAt = new Date().toISOString();
        stats.lastSyncStatus = "ok";
        await storageSet({ [STATS_KEY]: stats });
        emitMessage({ type: "STATS_UPDATED", stats });
        const queue = await getSheetsQueue();
        if (queue.length) createAlarm(ALARM_SHEETS_FLUSH, FLUSH_INTERVAL_MS);
        sendResponse({ ok: true, data });
      } else {
        sendResponse({ ok: false, error: cleanTextValue((data && (data.reason || data.message)) || "test_connection_failed") });
      }
      return;
    }

    if (type === "START_MANUAL_RUN") {
      const result = await startManualRun(sender && sender.tab && sender.tab.id);
      sendResponse(result);
      return;
    }

    if (type === "STOP_MANUAL_RUN") {
      const result = await withRunControl(() => stopManualRun());
      sendResponse(result);
      return;
    }

    if (type === "START_AUTO_CYCLE") {
      const result = await withRunControl(async () => {
        await clearRunAlarms();
        await stopAllTabs();
        return startAutoCycle(true);
      });
      sendResponse(result);
      return;
    }

    if (type === "STOP_AUTO_CYCLE") {
      await withRunControl(() => stopAutoCycle());
      sendResponse({ ok: true });
      return;
    }

    if (type === "PAUSE_ACTIVE_RUN") {
      const result = await withRunControl(() => pauseActiveRunNow());
      sendResponse(result);
      return;
    }

    if (type === "CONTINUE_ACTIVE_RUN") {
      const result = await withRunControl(() => continuePausedRunNow());
      sendResponse(result);
      return;
    }

    if (type === "GET_AUTO_STATE") {
      const state = await getAutoState();
      sendResponse({ ok: true, state });
      return;
    }

    if (type === "STOP_ALL_SCAN") {
      const result = await withRunControl(() => stopAllRunsNow());
      sendResponse(result);
      return;
    }

    if (type === "RESTART_ACTIVE_RUN") {
      const result = await withRunControl(() => restartActiveRunNow(sender && sender.tab && sender.tab.id));
      sendResponse(result);
      return;
    }

    if (type === "FLUSH_SHEETS_NOW") {
      await flushSheetsQueue();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown_message" });
  })().catch((err) => {
    derror("message failed", err);
    sendResponse({ ok: false, error: String(err && err.message || err) });
  });

  return true;
});
