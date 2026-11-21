// JellyJar - Popup Controller

const DEFAULT_WEBHOOK_URL = "https://jellybean-crm.lovable.app/api/public/nextdoor-leads";
const SINGLE_SEARCH_TEMPLATE_URL = "https://nextdoor.com/search/posts/?ccid=48929a0f-a231-49bc-ad47-6932dec901b8&navigationScreen=FEED&ssid=b71b3118-bde1-4804-a7ac-fdcc4769ca5e&query=handyman&postDateFilter=TODAY&postDistance=50&postDistanceUnit=MILES";

const DEFAULT_CONFIG = {
  webhookUrl: DEFAULT_WEBHOOK_URL,
  incogAccountName: "",
  accountArea: "",
  useSmartMatch: false,
  keywords: DEFAULT_INCLUDE_KEYWORDS,
  excludeKeywords: DEFAULT_EXCLUDE_KEYWORDS,
  sourceMode: "search",
  searchUrl: "",
  searchPlanMode: "rotation",
  singleSearchKeyword: "handyman",
  singleSearchMinutes: 15,
  neighborhoodStateCode: "ca",
  neighborhoodList: [],
  timeRangeHours: 24,
  customRangeStart: "",
  customRangeEnd: "",
  scrollSpeed: "normal",
  scrollDelayMs: 1000,
  scrollMinutes: 15,
  restMinutes: 0,
  cycleDurationHours: 0,
};

const state = {
  config: { ...DEFAULT_CONFIG },
  stats: null,
  queue: [],
  logs: [],
  autoState: {},
  lastStopAt: 0,
};

const els = {};
let saveTimer = null;
let liveTimer = null;
let actionBusy = false;
const textEncoder = new TextEncoder();
const THEME_STORAGE_KEY = "jellyjar-theme";

function $(id) {
  return document.getElementById(id);
}

function getPreferredTheme() {
  const requested = new URLSearchParams(window.location.search).get("theme");
  if (requested === "light" || requested === "dark") return requested;
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme, persist = false) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  if (els.themeToggle) {
    els.themeToggle.setAttribute(
      "aria-label",
      next === "dark" ? "Switch to light theme" : "Switch to dark theme"
    );
  }
  if (els.themeIcon) {
    els.themeIcon.src = next === "dark" ? "icons/sun.svg" : "icons/moon.svg";
  }
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, next);
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeKeywordText(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function sendMessage(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    const previewConfig = {
      ...DEFAULT_CONFIG,
      keywords: ["garage door", "water heater", "fence repair", "plumber", "handyman"],
    };
    const previewStats = {
      sessionCaptured: 24,
      sessionSynced: 18,
      sessionSkipped: 0,
      sessionPreCaptureSkipped: 0,
      sessionDuplicates: 0,
      lastSyncAt: "",
      scanDiagnostics: { scanned: 24, accepted: 24, rejected: 0, reasons: {} },
      skippedReasons: {},
      preCaptureReasons: {},
    };
    const previewResponses = {
      GET_CONFIG: { ok: true, config: previewConfig },
      GET_STATS: { ok: true, stats: previewStats },
      GET_QUEUE: { ok: true, queue: new Array(6).fill({ accountName: "JellyBean CRM" }) },
      GET_SCAN_LOGS: { ok: true, logs: [] },
      GET_AUTO_STATE: { ok: true, state: { running: false } },
      SAVE_CONFIG: { ok: true, config: message.config || previewConfig },
    };
    return Promise.resolve(previewResponses[message.type] || { ok: true });
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no_response" });
    });
  });
}

function crc32(bytes) {
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 31) << 11) |
    ((date.getMinutes() & 63) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 31);
  const dosDate =
    (((year - 1980) & 127) << 9) |
    (((date.getMonth() + 1) & 15) << 5) |
    (date.getDate() & 31);
  return { dosTime, dosDate };
}

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const dataBytes = textEncoder.encode(file.content);
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, now.dosTime, true);
    localView.setUint16(12, now.dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, now.dosTime, true);
    centralView.setUint16(14, now.dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, dataBytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDir = concatUint8Arrays(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDir.length, true);
  endView.setUint32(16, offset, true);

  return concatUint8Arrays([...localParts, centralDir, end]);
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function buildWorksheetXml(rows) {
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const ref = `${colName(colIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function buildXlsxBlob(rows) {
  const files = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Leads" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: buildWorksheetXml(rows),
    },
  ];

  return new Blob([makeZip(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function setStatus(text, tone = "info") {
  els.status.textContent = text;
  els.status.style.color =
    tone === "error" ? "#b91c1c" :
    tone === "success" ? "#166534" :
    tone === "warn" ? "#92400e" :
    "#1d4ed8";
}

function setPill(el, text, className) {
  el.className = className;
  el.textContent = text;
}

function formatLastSync(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatReason(value) {
  const raw = cleanText(value || "unknown");
  if (!raw) return "Unknown";
  const parts = raw.split(":");
  const source = cleanText(parts[0] || "");
  const detail = cleanText(parts.slice(1).join(":") || "");
  const title = source
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
  if (source === "exclude_keyword") return detail ? `Excluded keyword: ${detail}` : "Excluded keyword";
  if (source === "include_keyword") return detail ? `Included keyword: ${detail}` : "Included keyword";
  if (source === "smart_match") return detail ? `Smart match: ${detail}` : "Smart match";
  if (source === "crm_non_json_response") {
    return detail ? `CRM returned non-JSON response: ${formatReason(detail)}` : "CRM returned non-JSON response";
  }
  if (source === "crm_returned_html_page") {
    return detail ? `CRM returned an HTML page: ${detail}` : "CRM returned an HTML page instead of JSON";
  }
  return detail ? `${title}: ${detail}` : title;
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins <= 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCsvCell(value) {
  const text = String(value == null ? "" : value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsvContent(rows) {
  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
}

function getReasonEntries(reasonMap) {
  return Object.entries(reasonMap || {})
    .map(([reason, count]) => [cleanText(reason), Number(count || 0)])
    .filter(([reason, count]) => reason && count > 0)
    .sort((a, b) => b[1] - a[1]);
}

function getTopReasonText(reasonMap, limit = 3) {
  const entries = getReasonEntries(reasonMap).slice(0, limit);
  if (!entries.length) return "";
  return entries.map(([reason, count]) => `${formatReason(reason)}: ${count}`).join(" | ");
}

function getLossBreakdownText(stats) {
  const diag = (stats && stats.scanDiagnostics) || {};
  const scanScanned = Number(diag.scanned || 0);
  const scanAccepted = Number(diag.accepted || 0);
  const scanRejected = Number(diag.rejected || 0);

  const sessionCaptured = Number(stats?.sessionCaptured || 0);
  const sessionSynced = Number(stats?.sessionSynced || 0);
  const sessionSkipped = Number(stats?.sessionSkipped || 0);
  const sessionDuplicates = Number(stats?.sessionDuplicates || 0);
  const sessionPreCaptureSkipped = Number(stats?.sessionPreCaptureSkipped || 0);
  const queueCount = Array.isArray(state.queue) ? state.queue.length : 0;
  const failedCount = sessionSkipped + sessionPreCaptureSkipped;

  const parts = [];

  parts.push(`Scanned ${scanScanned}`);
  parts.push(`Accepted ${scanAccepted}`);
  parts.push(`Rejected ${scanRejected}`);
  parts.push(`Captured ${sessionCaptured}`);
  parts.push(`Queued ${queueCount}`);
  parts.push(`Synced ${sessionSynced}`);
  parts.push(`Duplicates ${sessionDuplicates}`);
  parts.push(`Failed ${failedCount}`);

  return parts.join(" | ");
}

function buildQueueReasonHint(stats) {
  const queueCount = Array.isArray(state.queue) ? state.queue.length : 0;
  const syncReasons = getTopReasonText(stats?.skippedReasons || {}, 3);
  const preCaptureReasons = getTopReasonText(stats?.preCaptureReasons || {}, 3);

  if (queueCount > 0 && cleanText(stats?.lastSyncStatus) && cleanText(stats?.lastSyncStatus) !== "ok") {
    return `Queue pending: ${queueCount}. Last sync error: ${formatReason(stats.lastSyncStatus)}.`;
  }

  if (queueCount > 0) {
    return `Queue pending: ${queueCount}. Waiting for next CRM sync.`;
  }

  if (syncReasons) {
    return `Queue clear. Top failed sync reasons: ${syncReasons}.`;
  }

  if (preCaptureReasons) {
    return `Queue clear. Top pre-capture failure reasons: ${preCaptureReasons}.`;
  }

  return "Queue clear. No pending rows.";
}

function getRunStateText() {
  const autoState = state.autoState || {};
  if (autoState.paused) return "Paused. Continue to resume the same search.";
  if (!autoState.running) return "Idle. Start a run to begin capturing leads.";

  const nextRunAt = Number(autoState.nextRunAt || 0);
  const remaining = nextRunAt ? Math.max(0, nextRunAt - Date.now()) : 0;
  const sourceLabel = cleanText(autoState.currentSourceLabel || autoState.currentSourceMode || "");

  if (autoState.mode === "manual") {
    return "Manual run active on the current Nextdoor tab.";
  }

  if (autoState.phase === "rest") {
    return `Resting now. Next run resumes in ${formatDuration(remaining)}.`;
  }

  if (autoState.phase === "scroll") {
    if (sourceLabel) {
      return `${formatReason(sourceLabel)} phase active. Next switch in ${formatDuration(remaining)}.`;
    }
    return `Auto cycle active. Next transition in ${formatDuration(remaining)}.`;
  }

  if (autoState.phase === "idle" && sourceLabel) {
    return `Preparing ${formatReason(sourceLabel)} phase.`;
  }

  return "Auto cycle is active.";
}

function getFiltersSummary() {
  const cfg = state.config || DEFAULT_CONFIG;
  const includeCount = Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean).length : 0;
  const excludeCount = Array.isArray(cfg.excludeKeywords) ? cfg.excludeKeywords.filter(Boolean).length : 0;
  const neighborhoodCount = Array.isArray(cfg.neighborhoodList) ? cfg.neighborhoodList.filter(Boolean).length : 0;

  if (!includeCount && !cfg.useSmartMatch) {
    return "No exact keywords and Smart Match is OFF. Scanning will not start.";
  }

  const parts = [];
  if (includeCount) parts.push(`${includeCount} include keyword(s)`);
  if (excludeCount) parts.push(`${excludeCount} exclude keyword(s)`);
  if (cleanText(cfg.sourceMode) === "neighborhood") parts.push(`${neighborhoodCount} neighborhood line(s)`);
  parts.push(cfg.useSmartMatch ? "Smart Match ON" : "Smart Match OFF");
  return parts.join(" | ");
}

function getOperationDetails() {
  const autoState = state.autoState || {};
  const nextRunAt = Number(autoState.nextRunAt || 0);
  const startedAt = Number(autoState.startedAt || 0);
  const remaining = nextRunAt ? Math.max(0, nextRunAt - Date.now()) : 0;
  const activeFor = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  const source = formatReason(
    autoState.currentSourceLabel ||
    autoState.currentSourceMode ||
    (autoState.mode === "manual" ? state.config.sourceMode : "")
  );

  if (autoState.paused) {
    return {
      badge: "Paused",
      runMode: "Auto Cycle",
      currentSource: source || "Search",
      currentAction: "Scanning and scrolling stopped",
      activeFor: formatDuration(activeFor),
      nextAction: "Continue the same search",
      nextIn: "On continue",
      stopState: "No scrolling or navigation is active.",
    };
  }

  if (!autoState.running) {
    return {
      badge: "Idle",
      runMode: "Stopped",
      currentSource: source || "-",
      currentAction: "Not scanning",
      activeFor: state.lastStopAt ? "Stopped" : "0s",
      nextAction: "No job scheduled",
      nextIn: "-",
      stopState: state.lastStopAt ? "Stop command completed." : "No stop command sent.",
    };
  }

  if (autoState.mode === "manual") {
    return {
      badge: "Manual",
      runMode: "Manual Scan",
      currentSource: source || "Recent",
      currentAction: "Scanning and auto-scrolling",
      activeFor: formatDuration(activeFor),
      nextAction: "Continue manual run on the current tab",
      nextIn: nextRunAt ? formatDuration(remaining) : "Live",
      stopState: "Use Stop to halt manual scanning and scrolling.",
    };
  }

  if (autoState.phase === "rest") {
    return {
      badge: "Resting",
      runMode: "Auto Cycle",
      currentSource: "-",
      currentAction: "Break period active",
      activeFor: formatDuration(activeFor),
      nextAction: "Resume scanning after rest",
      nextIn: formatDuration(remaining),
      stopState: "Stop will cancel the cycle immediately.",
    };
  }

  if (autoState.phase === "scroll") {
    return {
      badge: source || "Auto",
      runMode: "Auto Cycle",
      currentSource: source || "-",
      currentAction: "Scanning and auto-scrolling",
      activeFor: formatDuration(activeFor),
      nextAction:
        state.config.sourceMode === "both"
          ? (String(autoState.currentSourceMode || "").toLowerCase() === "recent"
              ? "Switch to Search"
              : "Start rest period")
          : "Move to the next search",
      nextIn: formatDuration(remaining),
      stopState: "Stop will end scrolling and scanning on all tabs.",
    };
  }

  return {
    badge: "Preparing",
    runMode: "Auto Cycle",
    currentSource: source || "-",
    currentAction: "Preparing next phase",
    activeFor: formatDuration(activeFor),
    nextAction: "Launch next phase",
    nextIn: nextRunAt ? formatDuration(remaining) : "-",
    stopState: "Stop will cancel the pending cycle.",
  };
}

function getSheetsStateText() {
  const cfg = state.config || DEFAULT_CONFIG;
  const stats = state.stats || {};
  const queue = Array.isArray(state.queue) ? state.queue : [];

  if (!cleanText(cfg.webhookUrl)) {
    return {
      pill: ["CRM Missing", "sheets-pill sheets-warn"],
      detail: "Add your CRM webhook URL to enable direct syncing."
    };
  }

  if (queue.length && cleanText(stats.lastSyncStatus) && cleanText(stats.lastSyncStatus) !== "ok") {
    return {
      pill: ["Retrying Sync", "sheets-pill sheets-err"],
      detail: `Last sync error: ${formatReason(stats.lastSyncStatus)}. ${queue.length} row(s) still queued.`,
    };
  }

  if (queue.length) {
    return {
      pill: ["CRM ready", "sheets-pill sheets-ok"],
      detail: `${queue.length} lead(s) are waiting to sync to the CRM.`,
    };
  }

  return {
    pill: ["CRM ready", "sheets-pill sheets-ok"],
    detail: "CRM is connected and no leads are waiting to sync."
  };
}

function renderStats() {
  const stats = state.stats || {
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
    scanDiagnostics: {
      scanned: 0,
      accepted: 0,
      rejected: 0,
      reasons: {},
    },
  };

  const queueCount = Array.isArray(state.queue) ? state.queue.length : 0;
  const failedCount = Number(stats.sessionSkipped || 0) + Number(stats.sessionPreCaptureSkipped || 0);

  els.statTotal.textContent = String(stats.sessionCaptured || 0);
  els.statSynced.textContent = String(stats.sessionSynced || 0);
  els.statCycles.textContent = String(failedCount);
  els.statLastSync.textContent = String(queueCount);

  const preCaptureReasons = getTopReasonText(stats.preCaptureReasons || {}, 3);
  const scanReasons = getTopReasonText(stats.scanDiagnostics?.reasons || {}, 3);
  const crmReasons = getTopReasonText(stats.skippedReasons || {}, 3);
  const duplicateCount = Number(stats.sessionDuplicates || 0);
  const summaryParts = [
    getLossBreakdownText(stats),
    duplicateCount ? `Duplicates blocked: ${duplicateCount}` : "",
    preCaptureReasons ? `Pre-capture failures: ${preCaptureReasons}` : "",
    scanReasons ? `Scan rejects: ${scanReasons}` : "",
    crmReasons ? `Sync failures: ${crmReasons}` : "",
  ].filter(Boolean);

  els.scanDiag.textContent = summaryParts.join(" || ");
}

function renderQueue() {
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const grouped = new Map();

  for (const row of queue) {
    const key = cleanText(row.incogAccount || row.accountName || row.accountArea || "Unknown");
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  els.queueBadge.textContent = String(queue.length);
  els.queueBadge.className = `queue-badge ${queue.length ? (queue.length > 20 ? "hot" : "") : "empty"}`.trim();

  const stats = state.stats || {};
  els.queueHint.textContent = buildQueueReasonHint(stats);

  if (!queue.length) {
    const crmReasons = getTopReasonText(stats.skippedReasons || {}, 4);
    els.queueRows.innerHTML = crmReasons
      ? `<div class="queue-empty">No rows queued. Recent sync failure reasons: ${escapeHtml(crmReasons)}</div>`
      : '<div class="queue-empty">No rows queued - all clear</div>';
    return;
  }

  const items = Array.from(grouped.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => `
      <div class="queue-row">
        <div class="queue-row-name">${escapeHtml(name)}</div>
        <div class="queue-row-count">${count}</div>
      </div>
    `)
    .join("");

  els.queueRows.innerHTML = items;
}

function renderLogs() {
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const pickedCount = logs.filter((entry) => cleanText(entry.decision) === "picked").length;
  const skippedCount = logs.filter((entry) => cleanText(entry.decision) === "skipped").length;
  const syncedCount = logs.filter((entry) => cleanText(entry.syncStatus) === "synced").length;
  const failedCount = logs.filter((entry) => cleanText(entry.syncStatus) === "failed").length;

  els.logsBadge.textContent = String(logs.length);
  els.logsHint.textContent = logs.length
    ? `Picked ${pickedCount} | Skipped ${skippedCount} | Synced ${syncedCount} | Failed ${failedCount}`
    : "Each scanned card will appear here with picked/skipped reason.";

  if (!logs.length) {
    els.logsPreview.innerHTML = '<div class="queue-empty">No scan logs yet.</div>';
    return;
  }

  const preview = logs.slice(0, 5).map((entry) => {
    const name = cleanText(entry.accountName || "Unknown");
    const reason = formatReason(entry.reason || entry.syncReason || "unknown");
    const decision = cleanText(entry.decision || "unknown");
    const syncStatus = cleanText(entry.syncStatus || "not_applicable");
    const label = decision === "picked"
      ? `Picked | ${syncStatus === "synced" ? "Synced" : syncStatus === "failed" ? "Sync failed" : "Queued"}`
      : "Skipped";
    return `
      <div class="queue-row">
        <div class="queue-row-name">${escapeHtml(name)} - ${escapeHtml(reason)}</div>
        <div class="queue-row-count">${escapeHtml(label)}</div>
      </div>
    `;
  }).join("");

  els.logsPreview.innerHTML = preview;
}

function renderSheetsStatus() {
  const next = getSheetsStateText();
  setPill(els.sheetsPill, next.pill[0], next.pill[1]);
}

function renderConnectionStatus() {
  const autoState = state.autoState || {};

  if (autoState.paused) {
    setPill(els.connPill, "Paused", "pill pill-warn");
    return;
  }

  if (autoState.running) {
    if (autoState.phase === "rest") {
      setPill(els.connPill, "Resting", "pill pill-warn");
      return;
    }
    if (autoState.mode === "manual") {
      setPill(els.connPill, "Manual Run", "pill pill-live");
      return;
    }
    const sourceLabel = formatReason(autoState.currentSourceLabel || autoState.currentSourceMode || "auto");
    setPill(els.connPill, sourceLabel, "pill pill-live");
    return;
  }

  if (state.stats && state.stats.cycling) {
    setPill(els.connPill, "Scanning", "pill pill-live");
    return;
  }

  setPill(els.connPill, "Connected", "pill pill-ok");
}

function renderAutoButton() {
  const running = !!(state.autoState && state.autoState.running);
  const paused = !!(state.autoState && state.autoState.paused);
  els.startStopBtn.textContent = actionBusy
    ? (running ? "Stopping..." : paused ? "Continuing..." : "Starting...")
    : running ? "Stop capture" : paused ? "Continue capture" : "Start capture";
  els.startStopBtn.disabled = actionBusy;
  els.startStopBtn.className = running
    ? "primary-action btn-d"
    : "primary-action btn-p";
}

function renderKeywordSummary() {
  if (!els.keywordSummary || !els.keywords) return;
  const keywords = normalizeKeywordText(els.keywords.value);
  if (!keywords.length) {
    els.keywordSummary.textContent = "Add keywords";
    return;
  }

  const visible = keywords.slice(0, 2).join(", ");
  const remaining = keywords.length - 2;
  els.keywordSummary.textContent = remaining > 0 ? `${visible} +${remaining}` : visible;
}

function openKeywordSettings() {
  if (els.settingsDrawer) els.settingsDrawer.open = true;
  requestAnimationFrame(() => {
    els.keywords.focus();
    els.keywords.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function renderSourceMode() {
  const mode = cleanText(els.sourceMode.value).toLowerCase();
  els.searchUrlWrap.style.display = ["search", "both"].includes(mode) ? "block" : "none";
  els.neighborhoodWrap.style.display = mode === "neighborhood" ? "block" : "none";
  renderSearchPlan();
}

function buildSingleSearchUrl(keyword) {
  const url = new URL(SINGLE_SEARCH_TEMPLATE_URL);
  url.searchParams.set("query", cleanText(keyword) || "handyman");
  return url.toString();
}

// Built-in rotation size in background.js, shown when the download has no CRM searches.
const BUILT_IN_SEARCH_COUNT = 11;

function describeSearchRotation() {
  const crmSearches = Array.isArray(JELLYJAR_CRM_SEARCHES) ? JELLYJAR_CRM_SEARCHES : [];
  if (!crmSearches.length) {
    return `Runs the built-in ${BUILT_IN_SEARCH_COUNT}-search schedule once, then stops.`;
  }
  const totalSeconds = crmSearches.reduce((sum, entry) => sum + entry.durationSeconds, 0);
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  const names = crmSearches.map((entry) => entry.label).join(", ");
  const count = crmSearches.length === 1 ? "1 search" : `${crmSearches.length} searches`;
  return `Runs ${count} from JellyBean (about ${minutes} min) once, then stops: ${names}.`;
}

function renderSearchPlan() {
  const isSingle = cleanText(els.searchPlanMode.value).toLowerCase() === "single";
  els.singleSearchWrap.style.display = isSingle ? "block" : "none";
  els.searchUrl.readOnly = isSingle;
  els.searchUrlHint.textContent = isSingle
    ? "Generated automatically from the selected keyword."
    : describeSearchRotation();
  if (isSingle) {
    els.searchUrl.value = buildSingleSearchUrl(els.singleSearchKeyword.value);
  }
}

function getSelectedSegValue(container, attrName, fallback) {
  const active = container.querySelector(".active");
  return active ? active.getAttribute(attrName) : fallback;
}

function setActiveByData(container, attrName, value) {
  container.querySelectorAll("[data-" + attrName + "]").forEach((node) => {
    node.classList.toggle(
      "active",
      String(node.getAttribute("data-" + attrName)) === String(value)
    );
  });
}

function renderTimeRange() {
  const isCustom = !!(state.config.customRangeStart && state.config.customRangeEnd);
  const activeValue = isCustom ? "custom" : String(state.config.timeRangeHours || 24);
  setActiveByData(els.timeRangeBtns, "hours", activeValue);
  els.customRange.classList.toggle("visible", isCustom);
}

function renderStatusSummary() {
  const runState = getRunStateText();
  const sheetsState = getSheetsStateText();

  const sessionCaptured = Number(state.stats?.sessionCaptured || 0);
  const sessionSynced = Number(state.stats?.sessionSynced || 0);
  const sessionSkipped = Number(state.stats?.sessionSkipped || 0);
  const sessionDuplicates = Number(state.stats?.sessionDuplicates || 0);
  const sessionPreCaptureSkipped = Number(state.stats?.sessionPreCaptureSkipped || 0);
  const queueCount = Array.isArray(state.queue) ? state.queue.length : 0;
  const failedCount = sessionSkipped + sessionPreCaptureSkipped;

  els.status.textContent = [
    runState,
    `Session: captured ${sessionCaptured}, queued ${queueCount}, synced ${sessionSynced}, duplicates ${sessionDuplicates}, failed ${failedCount}.`,
    sheetsState.detail,
  ].filter(Boolean).join(" ");
  els.status.style.color = "#1d4ed8";
}

function renderOperations() {
  const details = getOperationDetails();
  els.opsBadge.textContent = details.badge;
  els.runModeValue.textContent = details.runMode;
  els.currentSourceValue.textContent = details.currentSource;
  els.currentActionValue.textContent = details.currentAction;
  els.activeForValue.textContent = details.activeFor;
  els.nextActionValue.textContent = details.nextAction;
  els.nextInValue.textContent = details.nextIn;
  els.filtersLine.textContent = getFiltersSummary();
  els.sheetFlowLine.textContent = `${getSheetsStateText().detail} ${buildQueueReasonHint(state.stats || {})}`;
  els.stopStateLine.textContent = details.stopState;
}

function collectConfigFromForm() {
  const selectedHours = getSelectedSegValue(els.timeRangeBtns, "data-hours", "24");
  const customRangeStart = selectedHours === "custom" ? cleanText(els.rangeStart.value) : "";
  const customRangeEnd = selectedHours === "custom" ? cleanText(els.rangeEnd.value) : "";

  return {
    webhookUrl: cleanText(els.webhookUrl.value),
    incogAccountName: cleanText(els.incogAccountName.value),
    accountArea: cleanText(els.accountArea.value),
    useSmartMatch: !!els.smartMatch.checked,
    keywords: normalizeKeywordText(els.keywords.value),
    excludeKeywords: normalizeKeywordText(els.excludeKeywords.value),
    sourceMode: cleanText(els.sourceMode.value).toLowerCase() || "search",
    searchUrl: cleanText(els.searchPlanMode.value).toLowerCase() === "single"
      ? cleanText(state.config.searchUrl)
      : cleanText(els.searchUrl.value),
    searchPlanMode: cleanText(els.searchPlanMode.value).toLowerCase() === "single" ? "single" : "rotation",
    singleSearchKeyword: cleanText(els.singleSearchKeyword.value) || "handyman",
    singleSearchMinutes: Math.max(1, Number(els.singleSearchMinutes.value || 15)),
    neighborhoodStateCode: cleanText(els.neighborhoodStateCode.value).toLowerCase() || "ca",
    neighborhoodList: String(els.neighborhoodList.value || "")
      .split(/\r?\n/)
      .map((line) => cleanText(line))
      .filter(Boolean),
    timeRangeHours: selectedHours === "custom" ? 24 : Number(selectedHours || 24),
    customRangeStart,
    customRangeEnd,
    scrollSpeed: getSelectedSegValue(els.scrollSpeedGroup, "data-speed", "normal"),
    scrollDelayMs: Number(getSelectedSegValue(els.scrollDelayGroup, "data-delay", "1000")),
    scrollMinutes: Math.max(1, Number(els.scrollMinutes.value || 15)),
    restMinutes: Math.max(0, Number(els.restMinutes.value || 0)),
    cycleDurationHours: Number(getSelectedSegValue(els.cycleDurGroup, "data-dur", "0")),
  };
}

function fillForm(config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  state.config = cfg;

  els.webhookUrl.value = cleanText(cfg.webhookUrl);
  els.incogAccountName.value = cleanText(cfg.incogAccountName);
  els.accountArea.value = cleanText(cfg.accountArea);
  els.smartMatch.checked = !!cfg.useSmartMatch;
  els.keywords.value = Array.isArray(cfg.keywords) ? cfg.keywords.join(", ") : cleanText(cfg.keywords);
  els.excludeKeywords.value = Array.isArray(cfg.excludeKeywords) ? cfg.excludeKeywords.join(", ") : cleanText(cfg.excludeKeywords);
  els.sourceMode.value = cleanText(cfg.sourceMode || "search");
  els.searchUrl.value = cleanText(cfg.searchUrl);
  els.searchPlanMode.value = cleanText(cfg.searchPlanMode || "rotation") === "single" ? "single" : "rotation";
  els.singleSearchKeyword.value = cleanText(cfg.singleSearchKeyword || "handyman");
  els.singleSearchMinutes.value = String(Math.max(1, Number(cfg.singleSearchMinutes || 15)));
  els.neighborhoodStateCode.value = cleanText(cfg.neighborhoodStateCode || "ca");
  els.neighborhoodList.value = Array.isArray(cfg.neighborhoodList) ? cfg.neighborhoodList.join("\n") : cleanText(cfg.neighborhoodList);
  els.rangeStart.value = cleanText(cfg.customRangeStart);
  els.rangeEnd.value = cleanText(cfg.customRangeEnd);
  els.scrollMinutes.value = String(cfg.scrollMinutes || 15);
  els.restMinutes.value = String(Number(cfg.restMinutes || 0));

  setActiveByData(els.scrollSpeedGroup, "speed", cleanText(cfg.scrollSpeed || "normal"));
  setActiveByData(els.scrollDelayGroup, "delay", String(Number(cfg.scrollDelayMs || 1000)));
  setActiveByData(els.cycleDurGroup, "dur", String(Number(cfg.cycleDurationHours || 0)));
  renderSourceMode();
  renderTimeRange();
  renderKeywordSummary();
}

async function saveConfig(showFeedback = false) {
  const config = collectConfigFromForm();
  const response = await sendMessage({ type: "SAVE_CONFIG", config });

  if (response.ok) {
    state.config = { ...DEFAULT_CONFIG, ...(response.config || config) };
    renderSheetsStatus();
    renderSourceMode();
    renderTimeRange();
    renderStatusSummary();
    renderOperations();
    renderKeywordSummary();
    if (showFeedback) setStatus("Settings saved.", "success");
  } else if (showFeedback) {
    setStatus(`Could not save settings: ${cleanText(response.error || "unknown_error")}`, "error");
  }

  return response;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveConfig(false);
  }, 250);
}

async function refreshState() {
  const [configRes, statsRes, queueRes, logsRes, autoRes] = await Promise.all([
    sendMessage({ type: "GET_CONFIG" }),
    sendMessage({ type: "GET_STATS" }),
    sendMessage({ type: "GET_QUEUE" }),
    sendMessage({ type: "GET_SCAN_LOGS" }),
    sendMessage({ type: "GET_AUTO_STATE" }),
  ]);

  if (!configRes.ok || !statsRes.ok || !queueRes.ok || !logsRes.ok || !autoRes.ok) {
    setPill(els.connPill, "Disconnected", "pill pill-err");
    setStatus("Could not load extension state.", "error");
    return;
  }

  fillForm(configRes.config || {});
  state.stats = statsRes.stats || null;
  state.queue = queueRes.queue || [];
  state.logs = logsRes.logs || [];
  state.autoState = autoRes.state || {};

  renderStats();
  renderQueue();
  renderLogs();
  renderSheetsStatus();
  renderConnectionStatus();
  renderAutoButton();
  renderStatusSummary();
  renderOperations();
}

async function testSheets() {
  const url = cleanText(els.webhookUrl.value);

  if (!url) {
    setStatus("Enter the CRM webhook URL first.", "warn");
    return;
  }

  setPill(els.sheetsPill, "Testing...", "sheets-pill sheets-testing");
  setStatus("Testing CRM connection...", "info");
  await saveConfig(false);

  const response = await sendMessage({ type: "TEST_WEBHOOK", url });
  if (response.ok) {
    setStatus("CRM connection verified.", "success");
  } else {
    setStatus(`CRM test failed: ${cleanText(response.error || "unknown_error")}`, "error");
  }

  renderSheetsStatus();
  renderStatusSummary();
  renderOperations();
}

async function startStopRun() {
  if (actionBusy) return;
  actionBusy = true;
  renderAutoButton();
  try {
    await saveConfig(false);
    const running = !!(state.autoState && state.autoState.running);
    const paused = !!(state.autoState && state.autoState.paused);
    const action = running ? "stop" : paused ? "continue" : "start";
    setStatus(`${action === "continue" ? "Continuing" : action === "stop" ? "Stopping" : "Starting"} run...`, "info");

    const response = await sendMessage({
      type: running ? "PAUSE_ACTIVE_RUN" : paused ? "CONTINUE_ACTIVE_RUN" : "START_AUTO_CYCLE"
    });

    if (response.ok) {
      state.lastStopAt = running ? Date.now() : 0;
      setStatus(action === "stop" ? "Run stopped." : action === "continue" ? "Run continued." : "Run started.", "success");
    } else {
      setStatus(`Could not ${action} run: ${formatReason(response.error || `${action}_failed`)}`, "error");
    }
  } finally {
    await refreshState();
    actionBusy = false;
    renderAutoButton();
  }
}

async function restartRun() {
  await saveConfig(false);
  setStatus("Restarting run...", "info");

  const restartResponse = await sendMessage({ type: "RESTART_ACTIVE_RUN" });
  if (restartResponse.ok) {
    state.lastStopAt = 0;
    setStatus("Run restarted.", "success");
  } else {
    setStatus(
      `Could not restart run: ${formatReason(restartResponse.error || "restart_failed")}`,
      "error"
    );
  }

  await refreshState();
}

async function stopEverything() {
  const response = await sendMessage({ type: "STOP_ALL_SCAN" });

  if (response.ok) {
    state.lastStopAt = Date.now();
    setStatus("All scanning stopped.", "success");
  } else {
    setStatus(`Stop failed: ${cleanText(response.error || "unknown_error")}`, "error");
  }

  await refreshState();
}

function buildExportRows(posts) {
  const headers = [
    "Account Name",
    "Sub Area",
    "Posted Date & Time",
    "Post Text",
    "Final Link",
    "Profile Link",
    "Post Link",
    "Captured Date",
    "Captured Time",
    "Account Area",
    "Incog Account",
    "Matched Reason",
    "Source Mode",
  ];

  const lines = [headers];
  for (const post of posts) {
    lines.push([
      cleanText(post.accountName),
      cleanText(post.subArea),
      cleanText(post.postDateTime),
      cleanText(post.postText),
      cleanText(post.finalLink),
      cleanText(post.profileLink),
      cleanText(post.postLink),
      cleanText(post.capturedDate),
      cleanText(post.capturedTime),
      cleanText(post.accountArea),
      cleanText(post.incogAccount),
      cleanText(post.matchedReason),
      cleanText(post.sourceMode),
    ]);
  }

  return lines;
}

function buildLogExportRows(logs) {
  const headers = [
    "Scanned At",
    "Decision",
    "Reason",
    "Reason Source",
    "Reason Detail",
    "Capture Status",
    "Save Reason",
    "Sync Status",
    "Sync Reason",
    "Synced At",
    "Account Name",
    "Sub Area",
    "Posted Date & Time",
    "Post Text",
    "Final Link",
    "Profile Link",
    "Post Link",
    "Link Status",
    "Link Attempts",
    "Source Mode",
    "Page URL",
    "Account Area",
    "Incog Account",
    "Matched Reason",
  ];

  const lines = [headers];
  for (const log of logs) {
    lines.push([
      cleanText(log.scannedAt),
      cleanText(log.decision),
      cleanText(log.reason),
      cleanText(log.reasonSource),
      cleanText(log.reasonDetail),
      cleanText(log.captureStatus),
      cleanText(log.saveReason),
      cleanText(log.syncStatus),
      cleanText(log.syncReason),
      cleanText(log.syncedAt),
      cleanText(log.accountName),
      cleanText(log.subArea),
      cleanText(log.postDateTime),
      cleanText(log.postText),
      cleanText(log.finalLink),
      cleanText(log.profileLink),
      cleanText(log.postLink),
      cleanText(log.linkStatus),
      String(Number(log.linkAttempts || 0)),
      cleanText(log.sourceMode),
      cleanText(log.pageUrl),
      cleanText(log.accountArea),
      cleanText(log.incogAccount),
      cleanText(log.matchedReason),
    ]);
  }

  return lines;
}

async function exportXlsx() {
  const response = await sendMessage({ type: "GET_POSTS" });

  if (!response.ok) {
    setStatus("Could not load posts for export.", "error");
    return;
  }

  const posts = Array.isArray(response.posts) ? response.posts : [];
  if (!posts.length) {
    setStatus("No captured posts to export yet.", "warn");
    return;
  }

  const blob = buildXlsxBlob(buildExportRows(posts));
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nextdoor-leads-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);

  setStatus(`Exported ${posts.length} row(s) to XLSX.`, "success");
}

async function exportLogsCsv() {
  const response = await sendMessage({ type: "GET_SCAN_LOGS" });
  if (!response.ok) {
    setStatus("Could not load scan logs for export.", "error");
    return;
  }

  const logs = Array.isArray(response.logs) ? response.logs : [];
  if (!logs.length) {
    setStatus("No scan logs to export yet.", "warn");
    return;
  }

  const csv = buildCsvContent(buildLogExportRows(logs));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nextdoor-scan-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(url);

  setStatus(`Exported ${logs.length} scan log row(s) to CSV.`, "success");
}

async function exportLogsXlsx() {
  const response = await sendMessage({ type: "GET_SCAN_LOGS" });
  if (!response.ok) {
    setStatus("Could not load scan logs for export.", "error");
    return;
  }

  const logs = Array.isArray(response.logs) ? response.logs : [];
  if (!logs.length) {
    setStatus("No scan logs to export yet.", "warn");
    return;
  }

  const blob = buildXlsxBlob(buildLogExportRows(logs));
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nextdoor-scan-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);

  setStatus(`Exported ${logs.length} scan log row(s) to XLSX.`, "success");
}

async function clearLogs() {
  const confirmed = window.confirm("Clear only the scan logs?");
  if (!confirmed) return;

  const response = await sendMessage({ type: "CLEAR_SCAN_LOGS" });
  if (response.ok) {
    state.logs = [];
    renderLogs();
    setStatus("Scan logs cleared.", "success");
  } else {
    setStatus(`Could not clear logs: ${cleanText(response.error || "unknown_error")}`, "error");
  }
}

async function clearData() {
  const confirmed = window.confirm("Clear captured posts, queue, and stats?");
  if (!confirmed) return;

  const response = await sendMessage({ type: "CLEAR_POSTS" });
  if (response.ok) {
    setStatus("Captured data cleared.", "success");
  } else {
    setStatus(`Clear failed: ${cleanText(response.error || "unknown_error")}`, "error");
  }

  await refreshState();
}

function bindSegmentButtons(container, attrName) {
  container.querySelectorAll(`[data-${attrName}]`).forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      setActiveByData(container, attrName, node.getAttribute(`data-${attrName}`));
      if (container === els.timeRangeBtns) {
        const isCustom = node.getAttribute("data-hours") === "custom";
        els.customRange.classList.toggle("visible", isCustom);
      }
      scheduleSave();
    });
  });
}

function bindEvents() {
  bindSegmentButtons(els.scrollSpeedGroup, "speed");
  bindSegmentButtons(els.scrollDelayGroup, "delay");
  bindSegmentButtons(els.cycleDurGroup, "dur");
  bindSegmentButtons(els.timeRangeBtns, "hours");

  [
    els.webhookUrl,
    els.incogAccountName,
    els.accountArea,
    els.keywords,
    els.excludeKeywords,
    els.searchUrl,
    els.singleSearchKeyword,
    els.singleSearchMinutes,
    els.neighborhoodStateCode,
    els.neighborhoodList,
    els.rangeStart,
    els.rangeEnd,
    els.scrollMinutes,
    els.restMinutes,
  ].forEach((node) => {
    node.addEventListener("input", scheduleSave);
    node.addEventListener("change", scheduleSave);
  });

  els.smartMatch.addEventListener("change", scheduleSave);
  els.sourceMode.addEventListener("change", () => {
    renderSourceMode();
    scheduleSave();
  });
  els.searchPlanMode.addEventListener("change", () => {
    renderSearchPlan();
    scheduleSave();
  });
  els.singleSearchKeyword.addEventListener("input", renderSearchPlan);
  els.keywords.addEventListener("input", renderKeywordSummary);
  els.themeToggle.addEventListener("click", toggleTheme);
  els.editKeywordsBtn.addEventListener("click", openKeywordSettings);

  els.testSheetsBtn.addEventListener("click", testSheets);
  els.startStopBtn.addEventListener("click", startStopRun);
  els.restartBtn.addEventListener("click", restartRun);
  els.stopBtn.addEventListener("click", stopEverything);
  els.exportBtn.addEventListener("click", exportXlsx);
  els.clearBtn.addEventListener("click", clearData);
  els.exportLogsCsvBtn.addEventListener("click", exportLogsCsv);
  els.exportLogsXlsxBtn.addEventListener("click", exportLogsXlsx);
  els.clearLogsBtn.addEventListener("click", clearLogs);

  if (!globalThis.chrome?.runtime?.onMessage) return;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "STATS_UPDATED") {
      state.stats = msg.stats || state.stats;
      renderStats();
      renderQueue();
      renderSheetsStatus();
      renderConnectionStatus();
      renderStatusSummary();
      renderOperations();
      return;
    }

    if (msg.type === "SHEETS_QUEUE_UPDATED" || msg.type === "POSTS_UPDATED") {
      sendMessage({ type: "GET_QUEUE" }).then((response) => {
        if (response.ok) {
          state.queue = response.queue || [];
          renderQueue();
          renderStatusSummary();
          renderOperations();
        }
      });

      if (msg.stats) {
        state.stats = msg.stats;
        renderStats();
      } else {
        sendMessage({ type: "GET_STATS" }).then((response) => {
          if (response.ok) {
            state.stats = response.stats || state.stats;
            renderStats();
            renderQueue();
            renderStatusSummary();
            renderOperations();
          }
        });
      }
      return;
    }

    if (msg.type === "SCAN_LOGS_UPDATED") {
      sendMessage({ type: "GET_SCAN_LOGS" }).then((response) => {
        if (response.ok) {
          state.logs = response.logs || [];
          renderLogs();
        }
      });
      return;
    }

    if (msg.type === "AUTO_STATE_UPDATED") {
      state.autoState = msg.state || {};
      renderAutoButton();
      renderConnectionStatus();
      renderStatusSummary();
      renderOperations();
      return;
    }
  });
}

function cacheElements() {
  els.appRoot = $("appRoot");
  els.themeToggle = $("themeToggle");
  els.themeIcon = $("themeIcon");
  els.editKeywordsBtn = $("editKeywordsBtn");
  els.keywordSummary = $("keywordSummary");
  els.settingsDrawer = $("settingsDrawer");
  els.connPill = $("connPill");
  els.sheetsPill = $("sheetsPill");
  els.statTotal = $("statTotal");
  els.statSynced = $("statSynced");
  els.statCycles = $("statCycles");
  els.statLastSync = $("statLastSync");
  els.queueBadge = $("queueBadge");
  els.queueHint = $("queueHint");
  els.queueRows = $("queueRows");
  els.opsBadge = $("opsBadge");
  els.runModeValue = $("runModeValue");
  els.currentSourceValue = $("currentSourceValue");
  els.currentActionValue = $("currentActionValue");
  els.activeForValue = $("activeForValue");
  els.nextActionValue = $("nextActionValue");
  els.nextInValue = $("nextInValue");
  els.filtersLine = $("filtersLine");
  els.sheetFlowLine = $("sheetFlowLine");
  els.stopStateLine = $("stopStateLine");
  els.webhookUrl = $("webhookUrl");
  els.testSheetsBtn = $("testSheetsBtn");
  els.incogAccountName = $("incogAccountName");
  els.accountArea = $("accountArea");
  els.smartMatch = $("smartMatch");
  els.keywords = $("keywords");
  els.excludeKeywords = $("excludeKeywords");
  els.sourceMode = $("sourceMode");
  els.searchUrlWrap = $("searchUrlWrap");
  els.searchPlanMode = $("searchPlanMode");
  els.singleSearchWrap = $("singleSearchWrap");
  els.singleSearchKeyword = $("singleSearchKeyword");
  els.singleSearchMinutes = $("singleSearchMinutes");
  els.searchUrl = $("searchUrl");
  els.searchUrlHint = $("searchUrlHint");
  els.neighborhoodWrap = $("neighborhoodWrap");
  els.neighborhoodStateCode = $("neighborhoodStateCode");
  els.neighborhoodList = $("neighborhoodList");
  els.timeRangeBtns = $("timeRangeBtns");
  els.customRange = $("customRange");
  els.rangeStart = $("rangeStart");
  els.rangeEnd = $("rangeEnd");
  els.scrollSpeedGroup = $("scrollSpeedGroup");
  els.scrollDelayGroup = $("scrollDelayGroup");
  els.scrollMinutes = $("scrollMinutes");
  els.restMinutes = $("restMinutes");
  els.cycleDurGroup = $("cycleDurGroup");
  els.startStopBtn = $("startStopBtn");
  els.restartBtn = $("restartBtn");
  els.stopBtn = $("stopBtn");
  els.exportBtn = $("exportBtn");
  els.clearBtn = $("clearBtn");
  els.logsBadge = $("logsBadge");
  els.logsHint = $("logsHint");
  els.logsPreview = $("logsPreview");
  els.exportLogsCsvBtn = $("exportLogsCsvBtn");
  els.exportLogsXlsxBtn = $("exportLogsXlsxBtn");
  els.clearLogsBtn = $("clearLogsBtn");
  els.status = $("status");
  els.scanDiag = $("scanDiag");
}

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  applyTheme(getPreferredTheme());
  bindEvents();
  await refreshState();

  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    renderOperations();
    renderStatusSummary();
  }, 1000);
});
