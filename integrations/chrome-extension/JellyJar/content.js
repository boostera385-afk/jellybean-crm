// Account Boosters ND ext 2.0 â€” Content Script
(function () {
  "use strict";
  if (window.__ndScrapperActive) return;
  window.__ndScrapperActive = true;
  const DEBUG = true;
  function dlog(...args) {
    if (!DEBUG) return;
    console.log("[ND-CS]", ...args);
  }
  function dwarn(...args) {
    if (!DEBUG) return;
    console.warn("[ND-CS]", ...args);
  }
  function derror(...args) {
    if (!DEBUG) return;
    console.error("[ND-CS]", ...args);
  }
  let isScanning = false;
  let observer = null;
  let scanInterval = null;
  let scanBusy = false;
  let autoScrollActive = false;
  let runGeneration = 0;
  const seenInPage = new Set();
  const processingInPage = new Set();
  let useSmartMatch = false;
  let userKeywords = [];
  let userExcludeKeywords = [];
  let keywordMatcher = createKeywordMatcher([]);
  let excludeKeywordMatcher = createKeywordMatcher([]);
  let timeRangeHours = 24;
  let customRangeStart = null;
  let customRangeEnd = null;
  let scrollSpeed = "normal";
  let scrollDelayMs = 1000;
  let activeSourceMode = "recent";
  let neighborhoodPostLimit = 20;
  let neighborhoodProcessedCount = 0;
  let neighborhoodAcceptedCount = 0;
  const SCAN_INTERVAL_MS = 2500;
  const POST_LOAD_POLL_MS = 250;
  const POST_LOAD_SETTLE_MS = 700;
  const POST_LOAD_BOTTOM_WAIT_MS = 6000;
  const POST_LOAD_MAX_WAIT_MS = 10000;
  function getActiveScanIntervalMs() {
    return activeSourceMode === "neighborhood" ? 900 : SCAN_INTERVAL_MS;
  }
  function getObserverDebounceMs() {
    return activeSourceMode === "neighborhood" ? 180 : 500;
  }
  const MAX_POST_TEXT = 6000;
  let manualIncogAccountName = "";
  let manualAccountArea = "";
  const writeQueue = [];
  const PENDING_POSTS_KEY = "nd_pending_posts";
  let pendingQueueHydrated = false;
  let pendingQueueStoreChain = Promise.resolve();
  const discoveredPostUrls = [];
  const discoveredPostUrlSet = new Set();
  let writeFlushTimer = null;
  let writeFlushInProgress = false;
  let pageHookInjected = false;
  let scrollWatchdogTimer = null;
  let lastScrollActionAt = 0;
  let currentScanSessionId = "";
  const loggedCardDecisions = new Map();
  const ND = {
    feedItem: [
      '#main_content .js-media-post.clearfix.post',
      '[data-testid="feed-item-card"]',
      '[id^="feedItem_"]',
      '[data-testid^="dwell-tracker-feedItem"]',
      '[data-testid="feed-item-visibility-tracker"]',
      '[data-testid^="dwell-tracker-rolled_up_feed_item"]',
      ".js-media-post",
      '[class*="post-next-feed"]',
      "article",
    ],
    author: [
      'a[href*="is=feed_author"]',
      'a[href*="/profile/"]',
      '[data-block="17"] a',
      '[aria-label^="Avatar for"]',
      '[data-testid*="author"]',
      '[data-testid*="byline"] a',
    ],
    neighborhood: [
      '[data-testid*="neighborhood"]',
      '[data-testid*="location"]',
      'a[href*="/neighborhood/"]',
      'a[href*="/hood/"]',
      '[class*="neighborhood"]',
      '[class*="subArea"]',
      '[class*="locality"]',
      'span[class*="Hood"]',
    ],
    time: [
      'time[datetime]',
      "time",
      '[data-testid*="timestamp"]',
      '[data-testid*="time"]',
      'a[href*="/p/"] time',
    ],
    body: [
      'div[data-testid="post-body"]',
      'span[data-testid="styled-text"]',
      'div[class*="blocks-"] > div > span > div',
      'div[class*="blocks-"] span > div',
      '[data-testid*="content"]',
      '[data-testid*="body"]',
      ".cee-media-body p",
      ".Linkify",
      'p[dir="auto"]',
      'div[dir="auto"]',
      'span[dir="auto"]',
      '[class*="postBody"]',
      '[class*="post-body"]',
    ],
  };
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function nextQueueItemId() {
    return `cq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  function runPendingQueueStoreOp(fn) {
    pendingQueueStoreChain = pendingQueueStoreChain.then(fn, fn);
    return pendingQueueStoreChain;
  }
  function storageLocalGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }
  function storageLocalSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }
  async function getPendingStoredPosts() {
    const { [PENDING_POSTS_KEY]: posts = [] } = await storageLocalGet({ [PENDING_POSTS_KEY]: [] });
    return Array.isArray(posts) ? posts : [];
  }
  async function appendPendingStoredPosts(posts) {
    if (!Array.isArray(posts) || !posts.length) return;
    await runPendingQueueStoreOp(async () => {
      const current = await getPendingStoredPosts();
      const next = current.concat(posts);
      await storageLocalSet({ [PENDING_POSTS_KEY]: next });
    });
  }
  async function removePendingStoredPostsByIds(queueItemIds) {
    const ids = new Set((Array.isArray(queueItemIds) ? queueItemIds : []).map((id) => cleanText(id)).filter(Boolean));
    if (!ids.size) return;
    await runPendingQueueStoreOp(async () => {
      const current = await getPendingStoredPosts();
      const next = current.filter((post) => !ids.has(cleanText(post && post.queueItemId)));
      await storageLocalSet({ [PENDING_POSTS_KEY]: next });
    });
  }
  async function hydratePendingWriteQueue() {
    if (pendingQueueHydrated) return;
    pendingQueueHydrated = true;
    const pendingPosts = await getPendingStoredPosts();
    if (!pendingPosts.length) return;
    const queuedIds = new Set(writeQueue.map((post) => cleanText(post && post.queueItemId)).filter(Boolean));
    for (const post of pendingPosts) {
      const queueItemId = cleanText(post && post.queueItemId);
      if (queueItemId && queuedIds.has(queueItemId)) continue;
      writeQueue.push(post);
      if (queueItemId) queuedIds.add(queueItemId);
    }
  }
  function cleanText(v) {
    return String(v || "").replace(/\s+/g, " ").trim();
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }
  function isCurrentRun(runId) {
    return runGeneration === runId;
  }
  function normalizeDedupText(value, maxLen = 500) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen);
  }
  function buildScanLogKey(base, container) {
    const directPost = normalizePostUrl(base && (base.postLink || base.finalLink || ""));
    if (directPost) return `post:${directPost}`;
    const directProfile = normalizeProfileUrl(base && (base.profileLink || base.finalLink || ""));
    if (directProfile) return `profile:${directProfile}`;
    const author = normalizeDedupText(base && (base.accountName || base.author || ""), 120);
    const timeLabel = normalizeDedupText(base && (base.postDateTime || base.timestampLabel || ""), 120);
    const text = normalizeDedupText(base && (base.postText || base.text || ""), 240);
    const containerText = normalizeDedupText(
      container && (container.getAttribute("data-testid") || container.id || textFromNode(container)),
      140
    );
    return `scan:${author}|${timeLabel}|${text || containerText}`;
  }
  function buildScanLogEntry(base, container, extras = {}) {
    const reason = cleanText(extras.reason || "unknown");
    const reasonParts = reason.split(":");
    const matchedKeywords = Array.isArray(extras.matchedKeywords)
      ? extras.matchedKeywords.map((item) => cleanText(item)).filter(Boolean)
      : [];
    return {
      logId: cleanText(extras.logId || `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`),
      scanLogKey: buildScanLogKey({ ...(base || {}), ...(extras || {}) }, container),
      sessionId: currentScanSessionId,
      scannedAt: new Date().toISOString(),
      decision: cleanText(extras.decision || "unknown"),
      reason,
      reasonSource: cleanText(extras.reasonSource || reasonParts[0] || ""),
      reasonDetail: cleanText(extras.reasonDetail || reasonParts.slice(1).join(":") || ""),
      captureStatus: cleanText(extras.captureStatus || "unknown"),
      saveReason: cleanText(extras.saveReason || ""),
      syncStatus: cleanText(extras.syncStatus || "not_applicable"),
      syncReason: cleanText(extras.syncReason || ""),
      accountName: cleanText((extras.accountName != null ? extras.accountName : base && base.accountName) || ""),
      subArea: cleanText((extras.subArea != null ? extras.subArea : base && (base.subArea || base.neighborhood)) || ""),
      postDateTime: cleanText((extras.postDateTime != null ? extras.postDateTime : base && (base.postDateTime || base.timestampLabel)) || ""),
      postText: cleanText((extras.postText != null ? extras.postText : base && (base.postText || base.text)) || "").slice(0, MAX_POST_TEXT),
      finalLink: cleanText((extras.finalLink != null ? extras.finalLink : base && base.finalLink) || ""),
      profileLink: cleanText((extras.profileLink != null ? extras.profileLink : base && base.profileLink) || ""),
      postLink: cleanText((extras.postLink != null ? extras.postLink : base && base.postLink) || ""),
      linkStatus: cleanText((extras.linkStatus != null ? extras.linkStatus : base && base.linkStatus) || ""),
      linkAttempts: Number(extras.linkAttempts != null ? extras.linkAttempts : (base && base.linkAttempts) || 0),
      sourceMode: cleanText((extras.sourceMode != null ? extras.sourceMode : base && base.sourceMode) || ""),
      pageUrl: cleanText(window.location.href),
      accountArea: cleanText(manualAccountArea),
      incogAccount: cleanText(manualIncogAccountName),
      matchedReason: cleanText(extras.matchedReason || reason),
      matchedKeywords,
      notes: cleanText(extras.notes || ""),
    };
  }
  function shouldEmitScanLog(entry) {
    if (!entry || !entry.scanLogKey) return false;
    const signature = [
      cleanText(entry.decision),
      cleanText(entry.reason),
      cleanText(entry.captureStatus),
      cleanText(entry.finalLink || entry.profileLink || entry.postLink),
      cleanText(entry.linkStatus),
    ].join("|");
    const previous = loggedCardDecisions.get(entry.scanLogKey);
    if (previous === signature) return false;
    loggedCardDecisions.set(entry.scanLogKey, signature);
    return true;
  }
  function queryFirst(container, sels) {
    for (const sel of sels) {
      const el = container.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function getRecentContainers() {
    for (const sel of ND.feedItem) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length) return els;
    }
    return [];
  }
  function scoreSearchContainerCandidate(node) {
    if (!node) return -1000;
    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : { height: 0 };
    const linkCount = node.querySelectorAll ? node.querySelectorAll('a[href*="/p/"]').length : 0;
    const profileCount = node.querySelectorAll ? node.querySelectorAll('a[href*="/profile/"]').length : 0;
    const text = cleanText((node.innerText || node.textContent || "")).slice(0, 1200);
    let score = 0;
    score += Math.min(400, Math.max(0, rect.height || 0));
    if (node.matches && node.matches('[data-testid*="searchFeedItem"]')) score += 1000;
    if (node.tagName === "ARTICLE" || node.tagName === "LI" || node.tagName === "SECTION") score += 120;
    if (linkCount === 1) score += 160;
    if (linkCount > 1) score -= 220 * (linkCount - 1);
    if (profileCount >= 1) score += 60;
    if (/\b(hr|hrs|hour|hours|min|mins|minute|minutes|day|days|today|yesterday|just now)\b/i.test(text)) score += 60;
    if (text.length > 40) score += 40;
    if (text.length > 2500) score -= 200;
    return score;
  }
  function findSearchCardForLink(link) {
    if (!link) return null;
    const candidates = [];
    let current = link.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 8) {
      candidates.push(current);
      current = current.parentElement;
      depth += 1;
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => scoreSearchContainerCandidate(b) - scoreSearchContainerCandidate(a));
    return candidates[0] || null;
  }
  function getSearchContainers() {
    const direct = Array.from(document.querySelectorAll('[data-testid*="searchFeedItem"]'))
      .filter((node) => node && node.isConnected);
    if (direct.length) return direct;
    const roots = Array.from(document.querySelectorAll('#main_content a[href*="/p/"]'));
    const seen = new Set();
    const cards = [];
    for (const a of roots) {
      const card = findSearchCardForLink(a);
      if (!card) continue;
      const key = getSearchContainerKey(card, cards.length);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(card);
    }
    return cards;
  }
  function getContainers() {
    if (isSearchPostsUrl(window.location.href)) return getSearchContainers();
    return getRecentContainers();
  }
  function getSearchContainerKey(container, fallbackIndex = 0) {
    if (!container) return `search-${fallbackIndex}`;
    const postLink = pickSearchPostLink(container);
    if (postLink) return `post:${postLink}`;
    return cleanText(
      container.getAttribute("data-testid") ||
      container.id ||
      container.innerText ||
      `search-${fallbackIndex}`
    ).slice(0, 180);
  }
  function getVisibleSearchContainers() {
    const viewportTop = 0;
    const viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0;
    return getSearchContainers().filter((container) => {
      if (!container || !container.isConnected) return false;
      const rect = container.getBoundingClientRect();
      if (rect.height < 40) return false;
      return rect.bottom >= viewportTop + 20 && rect.top <= viewportBottom - 20;
    });
  }
  function getDocumentScrollHeight() {
    const doc = document.documentElement;
    const body = document.body;
    return Math.max(
      (doc && doc.scrollHeight) || 0,
      (body && body.scrollHeight) || 0
    );
  }
  function normalizeProfileUrl(url) {
    try {
      const u = new URL(String(url || ""), window.location.origin);
      const host = (u.hostname || "").toLowerCase();
      if (!(host === "nextdoor.com" || host.endsWith(".nextdoor.com"))) return "";
      const path = (u.pathname || "").replace(/\/+$/g, "");
      if (!path.startsWith("/profile/")) return "";
      return `${u.origin}${path}${u.search || ""}`;
    } catch {
      return "";
    }
  }
  function normalizeAnyLeadLink(url) {
    try {
      const cleaned = String(url || "").replace(/[)\],.'"]+$/g, "");
      const u = new URL(cleaned, window.location.origin);
      const host = (u.hostname || "").toLowerCase();
      if (!(host === "nextdoor.com" || host.endsWith(".nextdoor.com"))) return "";
      const path = (u.pathname || "").replace(/\/+$/g, "");
      if (!(path.startsWith("/profile/") || path.startsWith("/p/"))) return "";
      return `${u.origin}${path}${u.search || ""}`;
    } catch {
      return "";
    }
  }
  function normalizePostUrl(url) {
    try {
      const cleaned = String(url || "").replace(/[)\],.'"]+$/g, "");
      const u = new URL(cleaned, window.location.origin);
      const host = (u.hostname || "").toLowerCase();
      if (!(host === "nextdoor.com" || host.endsWith(".nextdoor.com"))) return "";
      const path = (u.pathname || "").replace(/\/+$/g, "");
      if (!path.startsWith("/p/")) return "";
      return `${u.origin}${path}${u.search || ""}`;
    } catch {
      return "";
    }
  }
  function pickSearchPostLink(container) {
  const hrefs = Array.from(container.querySelectorAll('a[href]'))
    .map((a) => normalizePostUrl(a.href || a.getAttribute('href') || ''))
    .filter(Boolean);

  const picked = hrefs[0] || "";
  if (picked) dlog("[SEARCH] picked postLink:", picked);
  return picked;
}
  function getPrimarySearchAnchor(container) {
    if (!container || !container.querySelectorAll) return null;
    const anchors = Array.from(container.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const normalized = normalizePostUrl(anchor.href || anchor.getAttribute("href") || "");
      if (normalized) return anchor;
    }
    return null;
  }
  function getPrimarySearchScope(container) {
    const anchor = getPrimarySearchAnchor(container);
    if (!anchor) return container;
    if (anchor.firstElementChild && anchor.childElementCount === 1) {
      return anchor.firstElementChild;
    }
    return anchor;
  }
  function splitSearchMetaParts(text) {
    return cleanText(text || '')
      .split(/\s*(?:Â·|·|•)\s*/)
      .map((part) => cleanText(part))
      .filter(Boolean);
  }
  function looksLikeSearchAreaText(txt) {
    const t = cleanText(txt);
    if (!t) return false;
    if (isSearchMetaText(t)) return false;
    if (t.length > 90) return false;
    if (/[.!?]/.test(t)) return false;
    if (/^\d+\s/.test(t)) return false;
    if (/(comment|reply|share|like|fave|recommend|looking for|need|hello|hi neighbors|please|thanks)/i.test(t)) return false;
    return true;
  }
  function normalizeSearchAreaText(txt) {
    const t = cleanText(txt);
    if (!looksLikeSearchAreaText(t)) return "";
    return t
      .replace(/\s*(?:Â·|·|•)\s*$/g, "")
      .replace(/^(avatar for\s+)/i, "")
      .trim();
  }
  function sanitizeSubArea(areaText, authorText) {
    const area = cleanText(areaText || "");
    const author = cleanText(authorText || "");
    if (!area) return "";
    if (author) {
      const lowerArea = area.toLowerCase();
      const lowerAuthor = author.toLowerCase();
      if (lowerArea === lowerAuthor) return "";
      if (lowerArea.startsWith(`${lowerAuthor} `)) {
        const stripped = cleanText(area.slice(author.length));
        if (stripped) return stripped;
        return "";
      }
    }
    return area;
  }
  function normalizeSearchTimeText(txt) {
    const t = cleanText(txt);
    if (!isSearchMetaText(t)) return "";
    const m = t.match(/\b(?:just now|today|yesterday|\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago?)\b/i);
    return cleanText((m && m[0]) || t);
  }
  function rememberDiscoveredPostUrls(urls) {
    for (const raw of Array.isArray(urls) ? urls : []) {
      const normalized = normalizePostUrl(raw);
      if (!normalized || discoveredPostUrlSet.has(normalized)) continue;
      discoveredPostUrlSet.add(normalized);
      discoveredPostUrls.unshift(normalized);
    }
    if (discoveredPostUrls.length > 50) {
      discoveredPostUrls.length = 50;
    }
  }
  function ensurePageHookInstalled() {
    if (pageHookInjected) return;
    pageHookInjected = true;
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page_hook.js");
      script.async = false;
      script.onload = () => {
        try {
          script.remove();
        } catch {}
      };
      (document.documentElement || document.head || document.body).appendChild(script);
    } catch (err) {
      derror("[HOOK] inject failed", err);
    }
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "nd-page-hook" || data.type !== "ND_POST_URLS_FOUND") return;
    rememberDiscoveredPostUrls(Array.isArray(data.urls) ? data.urls : []);
  });
  function isSearchMetaText(txt) {
    return /\b(ago|today|yesterday|just now|min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\b/i.test(cleanText(txt));
  }
  function getSearchHeaderCandidates(container) {
    const preferred = Array.from(container.querySelectorAll('a[href*="/profile/"], a[href*="is=feed_author"], time, [data-testid*="timestamp"]'))
      .map((el) => el && el.parentElement)
      .filter(Boolean);
    const unique = [];
    const seen = new Set();
    for (const node of preferred) {
      let current = node;
      let depth = 0;
      while (current && current !== container && depth < 4) {
        const key = `${current.tagName}:${cleanText(current.className || "")}:${cleanText(current.innerText || "").slice(0, 120)}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(current);
        }
        current = current.parentElement;
        depth += 1;
      }
    }
    unique.push(container);
    return unique;
  }
  function isSearchAuxiliaryNode(node, container) {
    if (!node || !container) return false;
    if (node.closest('[data-testid="tagged-entity-list"], [data-testid="tagged-entity-card-link"]')) return true;
    if (node.closest('a[href*="/page/"], a[href*="/business/"]')) return true;
    const primaryAnchor = getPrimarySearchAnchor(container);
    const enclosingPostAnchor = node.closest('a[href*="/p/"]');
    if (enclosingPostAnchor && primaryAnchor && enclosingPostAnchor !== primaryAnchor) return true;
    let current = node;
    while (current && current !== container) {
      const txt = cleanText(current.innerText || current.textContent || "");
      if (/^(westside handyman services|redondo beach)$/i.test(txt)) return true;
      current = current.parentElement;
    }
    return false;
  }
  function getSearchStructuredTextNodes(container) {
    return Array.from(container.querySelectorAll('div[data-testid*="styled-text-wrapper"], span[data-testid="styled-text"], div[dir="auto"], span[dir="auto"], p[dir="auto"]'))
      .filter((node) => !isSearchAuxiliaryNode(node, container));
  }
  function extractSearchAuthor(container) {
    const preferredLinks = Array.from(container.querySelectorAll('a[href*="/profile/"], a[href*="is=feed_author"], [aria-label^="Avatar for"]'));
    for (const link of preferredLinks) {
      let txt = cleanText(link.getAttribute("aria-label") || link.innerText || link.textContent || "");
      txt = txt.replace(/^avatar for\s+/i, "");
      if (txt && isLikelyAuthorText(txt)) return txt;
    }

    for (const header of getSearchHeaderCandidates(container)) {
      const spans = Array.from(header.querySelectorAll('span[data-testid="styled-text"], span, a[href*="/profile/"]'));
      for (const span of spans) {
        const txt = cleanText(span.innerText || span.textContent || "");
        if (!txt || !isLikelyAuthorText(txt)) continue;
        const parentText = cleanText((span.parentElement && span.parentElement.innerText) || "");
        if (!isSearchMetaText(txt) && !isSearchMetaText(parentText)) {
          return txt;
        }
      }
    }
    return extractAuthor(container);
  }
  function extractSearchMeta(container) {
    for (const header of getSearchHeaderCandidates(container)) {
      const nodes = Array.from(header.querySelectorAll('span[data-testid="styled-text"], span, time, a'));
      let bestArea = "";
      let bestTime = "";
      for (const node of nodes) {
        const txt = cleanText(node.innerText || node.textContent || "");
        if (!txt) continue;
        const parts = splitSearchMetaParts(txt);
        for (const part of parts) {
          const normalizedTime = normalizeSearchTimeText(part);
          if (normalizedTime && !bestTime) bestTime = normalizedTime;
          const normalizedArea = normalizeSearchAreaText(part);
          if (normalizedArea && !bestArea && normalizedArea !== extractSearchAuthor(container)) {
            bestArea = normalizedArea;
          }
        }
        if (!bestTime) {
          const normalizedTime = normalizeSearchTimeText(txt);
          if (normalizedTime) bestTime = normalizedTime;
        }
        if (!bestArea) {
          const normalizedArea = normalizeSearchAreaText(txt);
          if (normalizedArea && normalizedArea !== extractSearchAuthor(container)) bestArea = normalizedArea;
        }
      }
      if (bestArea || bestTime) {
        return {
          postDateTime: bestTime,
          subArea: bestArea,
        };
      }
    }

    const headerText = getSearchHeaderCandidates(container)
      .map((node) => cleanText(node && node.innerText || ""))
      .filter(Boolean)
      .join(" · ");
    const fallbackParts = splitSearchMetaParts(headerText);
    const fallbackArea = fallbackParts.map(normalizeSearchAreaText).find(Boolean) || "";
    const fallbackTime = fallbackParts.map(normalizeSearchTimeText).find(Boolean) || "";
    return { subArea: fallbackArea, postDateTime: fallbackTime };
  }
  function extractSearchPostText(container) {
    const nodes = getSearchStructuredTextNodes(container);
    let best = "";
    let bestScore = -1000;
    for (const n of nodes) {
      const txt = cleanText(n.innerText || n.textContent || "");
      if (!txt || txt.length < 20) continue;
      if (isSearchAuxiliaryNode(n, container)) continue;
      if (isCommentNode(n, container)) continue;
      if (isSearchMetaText(txt)) continue;
      let score = scorePostTextCandidate(txt);
      if (/\b(like|comment|share|reply|fave)\b/i.test(txt)) score -= 120;
      if (n.closest('a[href*="/profile/"]')) score -= 120;
      if (n.closest('[data-testid="tagged-entity-list"], [data-testid="tagged-entity-card-link"]')) score -= 300;
      if (n.closest('a[href*="/page/"], a[href*="/business/"]')) score -= 300;
      if (n.closest('button, [role="button"]')) score -= 140;
      if (txt.length > 180) score += 40;
      if (txt.split(" ").length >= 8) score += 30;
      if (score > bestScore) {
        bestScore = score;
        best = txt;
      }
    }
    if (!best) best = extractPostText(container);
    return best.slice(0, MAX_POST_TEXT);
  }
  function normalizeKeyText(s) {
    return cleanText(String(s || ""))
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .slice(0, 260);
  }
  function scorePostTextCandidate(text) {
    const txt = cleanText(text || "");
    if (!txt) return -1000;
    let score = txt.length;
    if (txt.length < 20) score -= 200;
    if (/\b(reply|share|like|comment|comments|reactions?)\b/i.test(txt)) score -= 120;
    if (/^\d+\s*(comments?|reactions?)$/i.test(txt)) score -= 200;
    return score;
  }
  function isCommentNode(node, container) {
    if (!node || !container) return false;
    const actionBar = Array.from(container.querySelectorAll('button, a, [role="button"]')).some((el) => {
      const txt = cleanText(el.innerText || el.textContent || "");
      return /^(like|comment|share|reply)$/i.test(txt);
    });
    if (!actionBar) return false;

    let current = node;
    while (current && current !== container) {
      const currentText = cleanText(current.innerText || current.textContent || "");
      if (/^\d+\s*(comments?|reactions?)$/i.test(currentText)) return true;
      if (/\b(reply|share)\b/i.test(currentText) && /\b(like)\b/i.test(currentText)) return true;
      current = current.parentElement;
    }
    return false;
  }
  function isLikelyAuthorText(value) {
    const txt = cleanText(value);
    if (!txt) return false;
    if (txt.length < 2 || txt.length > 80) return false;
    if (/^(today|yesterday|most relevant|distance|comment|reply|share)$/i.test(txt)) return false;
    if (/^\p{L}$/u.test(txt)) return false;
    if (/^[A-Z]\.?$/i.test(txt)) return false;
    if (/\b(hr|hrs|hour|hours|min|mins|minute|minutes|day|days)\b/i.test(txt)) return false;
    return /[A-Za-z]{2,}/.test(txt);
  }
  function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  async function forceRecentFeed(runId) {
    const MAX_TRIES = 20;
    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    function fireMouseSequence(el) {
      if (!el) return false;
      const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
      for (const type of events) {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window
          })
        );
      }
      return true;
    }
    function fireInputChange(el) {
      if (!el) return false;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    function isRecentActive(input, label) {
      if (input?.checked) return true;
      if (label) {
        const pressed = (label.getAttribute("data-pressed") || "").toLowerCase();
        const ariaDisabled = (label.getAttribute("aria-disabled") || "").toLowerCase();
        const className = label.className || "";
        if (pressed === "true") return true;
        if (ariaDisabled === "true") return true;
        if (/selected|active|checked/i.test(className)) return true;
      }
      return false;
    }
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      if (!isScanning || !isCurrentRun(runId)) return false;
      const input = document.querySelector('input[name="subnav"][value="RECENT_POSTS"]');
      if (!input) {
        console.log(`[ND] Recent input not found, try ${attempt}/${MAX_TRIES}`);
        await sleep(1000);
        continue;
      }
      const inputId = input.id;
      const label = inputId ? document.querySelector(`label[for="${CSS.escape(inputId)}"]`) : input.closest("label");
      if (isRecentActive(input, label)) {
        console.log("[ND] Recent already active");
        return true;
      }
      if (label) {
        fireMouseSequence(label);
        fireInputChange(label);
        await sleep(500);
        if (!isScanning || !isCurrentRun(runId)) return false;
        if (isRecentActive(input, label)) {
          console.log("[ND] Recent activated via label");
          return true;
        }
      }
      try {
        input.checked = true;
      } catch {}
      fireMouseSequence(input);
      fireInputChange(input);
      await sleep(500);
      if (!isScanning || !isCurrentRun(runId)) return false;
      if (isRecentActive(input, label)) {
        console.log("[ND] Recent activated via input");
        return true;
      }
      console.log(`[ND] Recent activation retry ${attempt}/${MAX_TRIES}`);
      await sleep(800);
    }
    console.warn("[ND] Could not confirm Recent filter after attempts");
    return false;
  }
  function isSearchPostsUrl(url) {
    try {
      const u = new URL(String(url || ""), window.location.origin);
      return (u.pathname || "").startsWith("/search/posts/");
    } catch {
      return false;
    }
  }
  function resolveSourceMode(config = {}) {
    const requested = cleanText(config.sourceMode || "recent").toLowerCase();
    if (requested === "search") return "search";
    if (requested === "neighborhood") return "neighborhood";
    if (requested === "both") return isSearchPostsUrl(window.location.href) ? "search" : "recent";
    return "recent";
  }
  function getScanProgressSnapshot() {
    const targetCount = Math.max(1, Number(neighborhoodPostLimit || 20));
    const rawLoadedCount = getContainers().length;
    const loadedCount = activeSourceMode === "neighborhood"
      ? Math.min(rawLoadedCount, targetCount)
      : rawLoadedCount;
    const processedCount = activeSourceMode === "neighborhood"
      ? Math.min(neighborhoodProcessedCount, targetCount)
      : loggedCardDecisions.size;
    const feedError = getNeighborhoodFeedErrorState();
    return {
      sourceMode: activeSourceMode,
      targetCount,
      loadedCount,
      processedCount,
      acceptedCount: activeSourceMode === "neighborhood" ? neighborhoodAcceptedCount : 0,
      limitReached: activeSourceMode === "neighborhood" && rawLoadedCount >= targetCount && processedCount >= targetCount,
      isSearch: isSearchPostsUrl(window.location.href),
      feedErrorVisible: !!feedError.visible,
      feedRetryAvailable: !!feedError.retryAvailable,
    };
  }
  function normalizeNeighborhoodName(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }
  function getNeighborhoodPageContext() {
    const titleEl = document.querySelector(".neighborhoodProfileTitle h2[data-block='33']");
    const cityEls = Array.from(document.querySelectorAll(".neighborhoodProfileTitle h2"));
    const cityEl = cityEls.length > 1 ? cityEls[1] : null;
    const title = cleanText((titleEl && (titleEl.innerText || titleEl.textContent)) || "");
    const city = cleanText((cityEl && (cityEl.innerText || cityEl.textContent)) || "");
    const cityName = cleanText((city.split(",")[0] || ""));
    const statsText = cleanText(
      Array.from(document.querySelectorAll(".neighborhoodProfileStats [data-testid='styled-text']"))
        .map((node) => node.innerText || node.textContent || "")
        .join(" ")
    );
    const postsMatch = statsText.match(/(\d+)\s+posts?\s+this\s+week/i);
    const postsThisWeek = postsMatch ? Number(postsMatch[1]) : -1;
    const feedError = getNeighborhoodFeedErrorState();
    return {
      ok: !!title,
      title,
      titleNormalized: normalizeNeighborhoodName(title),
      city,
      cityName,
      cityNormalized: normalizeNeighborhoodName(city),
      cityNameNormalized: normalizeNeighborhoodName(cityName),
      postsThisWeek,
      url: cleanText(window.location.href),
      feedErrorVisible: !!feedError.visible,
      feedRetryAvailable: !!feedError.retryAvailable,
    };
  }
  function getNeighborhoodFeedErrorState() {
    const bodyText = cleanText((document.body && (document.body.innerText || document.body.textContent)) || "");
    const visible = /sorry,\s*there was an error loading your feed/i.test(bodyText);
    let retryButton = null;
    if (visible) {
      retryButton = Array.from(document.querySelectorAll("button"))
        .find((button) => /^try again$/i.test(cleanText(button.innerText || button.textContent || "")));
    }
    return {
      visible,
      retryAvailable: !!retryButton,
      retryButton,
    };
  }
  function tryRecoverNeighborhoodFeedError() {
    const state = getNeighborhoodFeedErrorState();
    if (!state.visible || !state.retryButton) {
      return { ok: false, clicked: false, visible: state.visible, retryAvailable: state.retryAvailable };
    }
    try {
      state.retryButton.click();
      return { ok: true, clicked: true, visible: true, retryAvailable: true };
    } catch (err) {
      return { ok: false, clicked: false, visible: true, retryAvailable: true, error: String(err) };
    }
  }
  async function waitForSearchResultsReady(timeoutMs = 15000, runId = runGeneration) {
  const started = Date.now();
  let lastCount = 0;
  let stableRounds = 0;

  while (Date.now() - started < timeoutMs) {
    if (!isScanning || !autoScrollActive || !isCurrentRun(runId)) return false;
    const count = getSearchContainers().length;

    if (count > 0 && count === lastCount) {
      stableRounds += 1;
    } else {
      stableRounds = count > 0 ? 1 : 0;
    }

    lastCount = count;

    if (count >= 3 && stableRounds >= 3) return true;
    await sleep(500);
    if (!isScanning || !autoScrollActive || !isCurrentRun(runId)) return false;
  }

  return lastCount > 0;
}
  function uniqueNormalizedKeywords(raw) {
    const arr = Array.isArray(raw)
      ? raw
      : String(raw || "")
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
    return Array.from(new Set(arr.map((s) => cleanText(s.toLowerCase())).filter(Boolean)));
  }
  function normalizeMatchToken(token) {
    let t = cleanText(token || "").toLowerCase();
    if (!t) return "";
    if (t.length > 5 && t.endsWith("ied")) return `${t.slice(0, -3)}y`;
    if (t.length > 5 && t.endsWith("ing")) {
      t = t.slice(0, -3);
      if (/(.)\1$/.test(t)) t = t.slice(0, -1);
      return t;
    }
    if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
    if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
    if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
    return t;
  }
  function createKeywordMatcher(keywords, options = {}) {
    const mode = cleanText(options.mode || "broad").toLowerCase() || "broad";
    const normalized = uniqueNormalizedKeywords(keywords);
    const exact = [];
    const tokenIndex = new Map();
    for (const kw of normalized) {
      const esc = escapeRegex(kw);
      const rx = new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, "i");
      const words = kw.split(/\s+/).filter(Boolean);
      const normalizedWords = Array.from(new Set(words.map((word) => normalizeMatchToken(word)).filter(Boolean)));
      exact.push({ kw, rx, words, normalizedWords });
      for (const token of words) {
        if (!tokenIndex.has(token)) tokenIndex.set(token, []);
        tokenIndex.get(token).push({ kw, rx, words, normalizedWords });
      }
      for (const token of normalizedWords) {
        if (!tokenIndex.has(token)) tokenIndex.set(token, []);
        tokenIndex.get(token).push({ kw, rx, words, normalizedWords });
      }
    }
    return { exact, tokenIndex, total: normalized.length, mode };
  }
  function testMatcher(matcher, text) {
    const normalizedText = cleanText(text || "").toLowerCase();
    if (!normalizedText) return { hit: false, keyword: "" };
    if ((matcher && matcher.mode) === "exact") {
      for (const item of (matcher.exact || [])) {
        if (item.rx.test(normalizedText)) {
          return { hit: true, keyword: item.kw };
        }
      }
      return { hit: false, keyword: "" };
    }
    const candidates = new Map();
    const tokens = Array.from(new Set(normalizedText.split(/[^a-z0-9]+/).filter(Boolean)));
    const normalizedTokens = Array.from(new Set(tokens.map((token) => normalizeMatchToken(token)).filter(Boolean)));
    for (const token of tokens) {
      const list = matcher.tokenIndex.get(token);
      if (!list) continue;
      for (const item of list) candidates.set(item.kw, item);
    }
    for (const token of normalizedTokens) {
      const list = matcher.tokenIndex.get(token);
      if (!list) continue;
      for (const item of list) candidates.set(item.kw, item);
    }
    for (const item of candidates.values()) {
      if (item.rx.test(normalizedText)) {
        return { hit: true, keyword: item.kw };
      }
      if (Array.isArray(item.normalizedWords) && item.normalizedWords.length > 1) {
        const allWordsPresent = item.normalizedWords.every((word) => normalizedTokens.includes(word));
        if (allWordsPresent) {
          return { hit: true, keyword: item.kw };
        }
        const anyWordPresent = item.normalizedWords.some((word) => normalizedTokens.includes(word));
        if (anyWordPresent) {
          return { hit: true, keyword: item.kw };
        }
      }
      if (Array.isArray(item.normalizedWords) && item.normalizedWords.length === 1) {
        if (normalizedTokens.includes(item.normalizedWords[0])) {
          return { hit: true, keyword: item.kw };
        }
      }
    }
    return { hit: false, keyword: "" };
  }
  function makeFilterResult(ok, source, detail, fallbackReason = "") {
    const cleanDetail = cleanText(detail || "");
    const cleanSource = cleanText(source || "");
    const diagnosticReason = cleanDetail ? `${cleanSource}:${cleanDetail}` : (cleanSource || cleanText(fallbackReason || ""));
    return {
      ok: !!ok,
      source: cleanSource || cleanText(fallbackReason || ""),
      detail: cleanDetail,
      reason: diagnosticReason || cleanText(fallbackReason || "unknown"),
      reasonText: cleanDetail ? `${cleanSource}:${cleanDetail}` : (cleanSource || cleanText(fallbackReason || "unknown")),
    };
  }
  function passesFilters(postText) {
    const t = cleanText(postText || "");
    if (!t) return makeFilterResult(false, "empty_text", "", "empty_text");
    const excl = testMatcher(excludeKeywordMatcher, t);
    if (excl.hit) {
      return makeFilterResult(false, "exclude_keyword", excl.keyword, "exclude_keyword");
    }
    if (useSmartMatch) {
      const smartHit = builtInSmartMatch(t);
      if (smartHit.ok) return makeFilterResult(true, "smart_match", smartHit.reason, "smart_match");
    }
    if (!keywordMatcher.total) {
      return makeFilterResult(false, "no_filters_enabled", "", "no_filters_enabled");
    }
    const hit = testMatcher(keywordMatcher, t);
    if (hit.hit) return makeFilterResult(true, "include_keyword", hit.keyword, "include_keyword");
    return makeFilterResult(false, "no_keyword_match", "", "no_keyword_match");
  }
  function builtInSmartMatch(text) {
    const t = cleanText(text || "").toLowerCase();
    if (!t) return { ok: false, reason: "" };
    const patterns = [
      {
        label: "recommendation pattern",
        rx: /\b(need|looking for|recommend|recommendation for|anyone know|who do you use)\b.*\b(handyman|plumber|electrician|garage door|hvac|appliance|landscaping|sprinkler|cleaning|pest control|junk removal|moving)\b/i,
      },
      {
        label: "service request pattern",
        rx: /\b(handyman|plumber|electrician|garage door|hvac|appliance|landscaping|sprinkler|cleaning|pest control|junk removal|moving)\b.*\b(needed|needed asap|repair|service|quote|estimate|recommendation)\b/i,
      },
    ];
    for (const pattern of patterns) {
      if (pattern.rx.test(t)) return { ok: true, reason: pattern.label };
    }
    return { ok: false, reason: "" };
  }
  function parsePostTimeToUnix(label, isoValue) {
    if (isoValue) {
      const ts = Date.parse(isoValue);
      if (Number.isFinite(ts)) return ts;
    }
    const raw = cleanText(label).toLowerCase();
    if (!raw) return 0;
    const now = Date.now();
    if (raw.includes("just now")) return now;
    let m = raw.match(/(\d+)\s*(min|mins|minute|minutes)\b/);
    if (m) return now - Number(m[1]) * 60 * 1000;
    m = raw.match(/(\d+)\s*(hr|hrs|hour|hours)\b/);
    if (m) return now - Number(m[1]) * 60 * 60 * 1000;
    m = raw.match(/(\d+)\s*(day|days)\b/);
    if (m) return now - Number(m[1]) * 24 * 60 * 60 * 1000;
    if (raw.includes("yesterday")) return now - 24 * 60 * 60 * 1000;
    if (raw.includes("today")) return now;
    m = raw.match(/^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?$/i);
    if (m) {
      const day = Number(m[1]);
      const monthToken = String(m[2] || "").slice(0, 3).toLowerCase();
      const months = {
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
      };
      if (Number.isFinite(day) && Object.prototype.hasOwnProperty.call(months, monthToken)) {
        const current = new Date();
        const year = Number(m[3]) || current.getFullYear();
        let candidate = new Date(year, months[monthToken], day, 12, 0, 0, 0);
        if (!m[3] && candidate.getTime() > now + (24 * 60 * 60 * 1000)) {
          candidate = new Date(year - 1, months[monthToken], day, 12, 0, 0, 0);
        }
        const parsed = candidate.getTime();
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return 0;
  }
  function withinTimeRange(label, isoValue) {
    const ts = parsePostTimeToUnix(label, isoValue);
    if (!ts) return true;
    if (customRangeStart || customRangeEnd) {
      if (customRangeStart) {
        const start = Date.parse(customRangeStart);
        if (Number.isFinite(start) && ts < start) return false;
      }
      if (customRangeEnd) {
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(customRangeEnd);
        const end = Date.parse(customRangeEnd);
        const inclusiveEnd = Number.isFinite(end) && isDateOnly ? end + (24 * 60 * 60 * 1000) - 1 : end;
        if (Number.isFinite(inclusiveEnd) && ts > inclusiveEnd) return false;
      }
      return true;
    }
    const maxMs = Number(timeRangeHours || 24) * 60 * 60 * 1000;
    return Date.now() - ts <= maxMs;
  }
  function textFromNode(el) {
    return cleanText((el && (el.innerText || el.textContent)) || "");
  }
  function extractAuthor(container) {
    const preferredLinks = Array.from(container.querySelectorAll('a[href*="/profile/"], a[href*="is=feed_author"]'));
    for (const link of preferredLinks) {
      const txt = textFromNode(link).replace(/^avatar for\s+/i, "");
      if (txt && txt.length > 1) return txt;
    }
    const authorEl = queryFirst(container, ND.author);
    if (authorEl) {
      const txt = textFromNode(authorEl).replace(/^avatar for\s+/i, "");
      if (txt && txt.length > 1) return txt;
    }
    const text = textFromNode(container);
    const firstLine = cleanText((text.split("\n").find(Boolean) || "").replace(/^avatar for\s+/i, ""));
    return firstLine.slice(0, 120);
  }
  function extractNeighborhood(container) {
    const el = queryFirst(container, ND.neighborhood);
    if (el) {
      const txt = textFromNode(el);
      if (txt) return txt;
    }
    return "";
  }
  function extractTimeInfo(container) {
    const el = queryFirst(container, ND.time);
    if (!el) return { label: "", iso: "" };
    const label = textFromNode(el);
    const iso = cleanText(el.getAttribute("datetime") || "");
    return { label, iso };
  }
  function extractPostText(container) {
    let best = "";
    for (const sel of ND.body) {
      const nodes = Array.from(container.querySelectorAll(sel));
      for (const n of nodes) {
        const txt = textFromNode(n);
        if (txt.length > best.length) best = txt;
      }
      if (best) break;
    }
    if (!best) {
      best = textFromNode(container);
    }
    return best.slice(0, MAX_POST_TEXT);
  }

  function getClosestCandidateLinks(container) {
    const links = [];
    const seen = new Set();
    const pushLink = (href, source) => {
      const raw = cleanText(href);
      if (!raw) return;
      const key = `${raw}__${cleanText(source || "unknown")}`;
      if (seen.has(key)) return;
      seen.add(key);
      links.push({ href: raw, source: cleanText(source || "unknown") });
    };
    const pushTextUrls = (value, source) => {
      const raw = String(value || "");
      if (!raw) return;
      const matches = raw.match(/https?:\/\/(?:[\w-]+\.)?nextdoor\.com\/(?:p|profile)\/[^\s"'<>]+/gi) || [];
      for (const match of matches) {
        pushLink(match, source);
      }
    };
    const collectFromNode = (node, source) => {
      if (!node || !node.getAttributeNames) return;
      for (const attr of node.getAttributeNames()) {
        const value = node.getAttribute(attr);
        if (!value) continue;
        if (/href|url|link|path|target/i.test(attr)) {
          pushLink(value, `${source}:${attr}`);
        }
        pushTextUrls(value, `${source}:${attr}`);
      }
    };

    if (container && container.querySelectorAll) {
      collectFromNode(container, "container_root");
      Array.from(container.querySelectorAll('a[href]')).forEach((a) => {
        pushLink(a.href || a.getAttribute("href") || "", "container");
      });
      Array.from(container.querySelectorAll("[data-url],[data-href],[data-post-url],[onclick],[aria-label]")).slice(0, 20).forEach((node) => {
        collectFromNode(node, "container_meta");
      });
    }

    let current = container && container.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 4) {
      collectFromNode(current, `ancestor_${depth + 1}_root`);
      Array.from(current.querySelectorAll('a[href]')).slice(0, 12).forEach((a) => {
        pushLink(a.href || a.getAttribute("href") || "", `ancestor_${depth + 1}`);
      });
      Array.from(current.querySelectorAll("[data-url],[data-href],[data-post-url],[onclick],[aria-label]")).slice(0, 12).forEach((node) => {
        collectFromNode(node, `ancestor_${depth + 1}_meta`);
      });
      current = current.parentElement;
      depth += 1;
    }

    return links;
  }
  function extractProfileLink(container) {
    const candidates = getClosestCandidateLinks(container);
    for (const item of candidates) {
      const norm = normalizeProfileUrl(item.href);
      if (norm) return norm;
    }
    return "";
  }
  function extractPostLink(container) {
    const candidates = getClosestCandidateLinks(container);
    for (const item of candidates) {
      const norm = normalizePostUrl(item.href);
      if (norm) return norm;
    }
    return "";
  }
function findDiscoveredPostUrlNearText(postText) {
  const normalizedText = cleanText(postText).toLowerCase();
  if (!normalizedText) return "";

  const textTokens = normalizedText
    .split(/[^a-z0-9]+/)
    .filter((token) => token && token.length >= 4)
    .slice(0, 12);

  if (!textTokens.length) return "";

  for (const raw of discoveredPostUrls) {
    const clean = normalizePostUrl(raw);
    if (!clean) continue;

    const lower = clean.toLowerCase();
    const tokenHits = textTokens.filter((token) => lower.includes(token)).length;

    if (tokenHits >= 2) {
      return clean;
    }
  }

  return "";
}
  function buildDuplicateKeysForPost(postLike) {
    const postLink = normalizePostUrl(postLike && (postLike.postLink || postLike.finalLink || postLike.id || ""));
    const profileLink = normalizeProfileUrl(postLike && (postLike.profileLink || postLike.finalLink || ""));
    const author = normalizeDedupText(postLike && (postLike.accountName || postLike.author || ""), 120);
    const text = normalizeDedupText(postLike && (postLike.postText || postLike.text || ""), 700);
    const timeLabel = normalizeDedupText(postLike && (postLike.postDateTime || postLike.timestampLabel || ""), 120);
    const keys = [];

    if (postLink) keys.push(`post:${postLink}`);
    if (profileLink && text) keys.push(`profile_text:${profileLink}|${text}`);
    if (author && timeLabel && text) keys.push(`content:${author}|${timeLabel}|${text}`);
    if (!keys.length && text) keys.push(`text:${text}`);

    return Array.from(new Set(keys));
  }
async function tryResolveBestLeadLink(container, postText, attempts = 6, waitMs = 900) {
  let best = {
    ok: false,
    profileLink: "",
    postLink: "",
    finalLink: "",
    attempts: 0,
    usedHookFallback: false,
  };

  for (let i = 0; i < attempts; i++) {
    const profile = extractProfileLink(container);

    const domPostLink = isSearchPostsUrl(window.location.href)
      ? (pickSearchPostLink(container) || extractPostLink(container))
      : extractPostLink(container);

    const hookPostLink = findDiscoveredPostUrlNearText(postText);
    const postLink = normalizePostUrl(profile ? "" : (domPostLink || hookPostLink || ""));
    const finalLink = normalizeAnyLeadLink(profile || domPostLink || hookPostLink || "");

    dlog("[LINK_RESOLVE]", {
      attempt: i + 1,
      profileLink: profile,
      domPostLink,
      hookPostLink,
      finalLink,
      text: cleanText(postText).slice(0, 140),
    });

    best = {
      ok: !!finalLink,
      profileLink: profile || "",
      postLink: postLink || "",
      finalLink: finalLink || "",
      attempts: i + 1,
      usedHookFallback: !!(!profile && !!hookPostLink && !domPostLink),
    };

    if (finalLink) {
      return best;
    }

    if (i < attempts - 1) {
      await sleep(waitMs);
    }
  }

  return best;
}
  function buildPayloadFromContainer(container) {
    const isSearch = isSearchPostsUrl(window.location.href);
    const searchScope = isSearch ? getPrimarySearchScope(container) : container;
    const author = isSearch ? extractSearchAuthor(searchScope) : extractAuthor(container);
    const meta = isSearch ? extractSearchMeta(searchScope) : null;
    const rawSubArea = isSearch ? cleanText(meta && meta.subArea) : extractNeighborhood(container);
    const subArea = sanitizeSubArea(rawSubArea, author);
    const timeInfo = isSearch
      ? { label: cleanText(meta && meta.postDateTime), iso: "" }
      : extractTimeInfo(container);
    const postText = isSearch ? extractSearchPostText(searchScope) : extractPostText(container);
    return {
      accountName: author,
      subArea: subArea,
      postDateTime: cleanText(timeInfo.label),
      timestampIso: cleanText(timeInfo.iso),
      postText: cleanText(postText),
      sourceMode: isSearch ? "search" : (activeSourceMode === "neighborhood" ? "neighborhood" : "recent"),
    };
  }
  function notifyBackground(posts) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "SAVE_POSTS", posts }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: true });
      });
    });
  }
  async function flushWriteQueue() {
    writeFlushTimer = null;
    if (writeFlushInProgress) return;
    await hydratePendingWriteQueue();
    if (!writeQueue.length) return;

    writeFlushInProgress = true;
    const MAX_BG_BATCH = 25;

    try {
      while (writeQueue.length) {
        const batch = writeQueue.slice(0, MAX_BG_BATCH);
        const resp = await notifyBackground(batch);

        if (!resp || resp.ok !== true) {
          derror("[WRITE] flush failed", resp);
          scheduleWriteFlush();
          break;
        }

        const batchIds = batch.map((post) => cleanText(post && post.queueItemId)).filter(Boolean);
        writeQueue.splice(0, batch.length);
        await removePendingStoredPostsByIds(batchIds);
        dlog("[WRITE] flushed", { count: batch.length, resp });
      }
    } catch (err) {
      derror("[WRITE] flush failed", err);
      scheduleWriteFlush();
    } finally {
      writeFlushInProgress = false;
      if (writeQueue.length && !writeFlushTimer) {
        scheduleWriteFlush();
      }
    }
  }
  function scheduleWriteFlush() {
    if (writeFlushTimer) return;
    writeFlushTimer = setTimeout(flushWriteQueue, 60);
  }
  async function pushToWriteQueue(post) {
    if (!post || typeof post !== "object") return;
    if (!cleanText(post.queueItemId)) {
      post.queueItemId = nextQueueItemId();
    }
    writeQueue.push(post);
    await appendPendingStoredPosts([post]);
    scheduleWriteFlush();
  }
  function startScrollWatchdog() {
    stopScrollWatchdog();
  }
  function stopScrollWatchdog() {
    if (scrollWatchdogTimer) {
      clearInterval(scrollWatchdogTimer);
      scrollWatchdogTimer = null;
    }
  }
  async function processContainer(container, runId) {
  if (!isCurrentRun(runId) || !isScanning) return { accepted: false, reason: "stopped" };
  if (!container || !container.isConnected) return null;

  const base = buildPayloadFromContainer(container);
  if (!isCurrentRun(runId) || !isScanning) return { accepted: false, reason: "stopped" };

  if (!base.postText) {
    dwarn("[SCAN_SKIP] empty_text");
    return {
      accepted: false,
      reason: "empty_text",
      logEntry: buildScanLogEntry(base, container, {
        decision: "skipped",
        reason: "empty_text",
        reasonSource: "empty_text",
        captureStatus: "not_captured",
        syncStatus: "not_applicable",
      }),
    };
  }

  const filter = passesFilters(base.postText);
  if (!filter.ok) {
    dlog("[SCAN_SKIP] filter_rejected", {
      reason: filter.reason,
      source: filter.source,
      detail: filter.detail,
      text: base.postText.slice(0, 160),
    });
    return {
      accepted: false,
      reason: filter.reason,
      logEntry: buildScanLogEntry(base, container, {
        decision: "skipped",
        reason: filter.reason,
        reasonSource: filter.source,
        reasonDetail: filter.detail,
        captureStatus: "not_captured",
        syncStatus: "not_applicable",
        matchedReason: filter.reason,
      }),
    };
  }

  if (!withinTimeRange(base.postDateTime, base.timestampIso)) {
    dlog("[SCAN_SKIP] out_of_range", {
      postDateTime: base.postDateTime,
      timestampIso: base.timestampIso,
    });
    return {
      accepted: false,
      reason: "out_of_range",
      logEntry: buildScanLogEntry(base, container, {
        decision: "skipped",
        reason: "out_of_range",
        reasonSource: "out_of_range",
        captureStatus: "not_captured",
        syncStatus: "not_applicable",
      }),
    };
  }

  const linkResult = await tryResolveBestLeadLink(container, base.postText, 6, 800);
  if (!isCurrentRun(runId) || !isScanning) return { accepted: false, reason: "stopped" };

  if (!linkResult.ok) {
    dwarn("[SCAN_ACCEPT_WITHOUT_LINK]", {
      attempts: linkResult.attempts,
      text: base.postText.slice(0, 180),
    });
  }

  const post = {
    id: linkResult.postLink || linkResult.finalLink || `text:${normalizeDedupText(base.postText, 180)}`,
    accountName: base.accountName,
    author: base.accountName,
    profileLink: linkResult.profileLink,
    postLink: linkResult.postLink,
    finalLink: linkResult.finalLink,
    linkStatus: linkResult.ok ? "resolved" : "missing",
    missingLink: !linkResult.ok,
    linkAttempts: Number(linkResult.attempts || 0),
    subArea: base.subArea,
    neighborhood: base.subArea,
    postDateTime: base.postDateTime,
    timestampLabel: base.postDateTime,
    timestampIso: base.timestampIso,
    timestampUnix: parsePostTimeToUnix(base.postDateTime, base.timestampIso),
    postText: base.postText,
    text: base.postText,
    url: window.location.href,
    capturedFromUrl: window.location.href,
    incogAccount: manualIncogAccountName,
    accountArea: manualAccountArea,
    matchedReason: filter.reason,
    matchedKeywords: [],
    sourceMode: base.sourceMode,
    scrapedAt: new Date().toISOString(),
    captureDateTime: new Date().toISOString(),
    queueItemId: nextQueueItemId(),
  };
  post.scanLogKey = buildScanLogKey(post, container);

  const duplicateKeys = buildDuplicateKeysForPost(post);
  if (duplicateKeys.some((key) => seenInPage.has(key) || processingInPage.has(key))) {
    dlog("[SCAN_SKIP] duplicate_in_page", {
      duplicateKeys,
      postLink: post.postLink,
      profileLink: post.profileLink,
      text: post.postText.slice(0, 160),
    });
    return {
      accepted: false,
      reason: "duplicate_in_page",
      logEntry: buildScanLogEntry(post, container, {
        decision: "skipped",
        reason: "duplicate_in_page",
        reasonSource: "duplicate_in_page",
        captureStatus: "not_captured",
        syncStatus: "not_applicable",
        matchedReason: filter.reason,
      }),
    };
  }

  duplicateKeys.forEach((key) => processingInPage.add(key));

  try {
    dlog("[SCAN_ACCEPT]", {
      profileLink: post.profileLink,
      postLink: post.postLink,
      finalLink: post.finalLink,
      linkStatus: post.linkStatus,
      usedHookFallback: !!linkResult.usedHookFallback,
      text: post.postText.slice(0, 160),
    });

    if (!isCurrentRun(runId) || !isScanning) return { accepted: false, reason: "stopped" };

    await pushToWriteQueue(post);
    duplicateKeys.forEach((key) => seenInPage.add(key));

    return {
      accepted: true,
      reason: filter.reason,
      logEntry: buildScanLogEntry(post, container, {
        decision: "picked",
        reason: filter.reason,
        reasonSource: filter.source,
        reasonDetail: filter.detail,
        captureStatus: "pending_save",
        syncStatus: "pending_queue",
        matchedReason: filter.reason,
      }),
    };
  } finally {
    duplicateKeys.forEach((key) => processingInPage.delete(key));
  }
}
  async function scanVisibleNow() {
    if (scanBusy) return;
    if (
      activeSourceMode === "neighborhood" &&
      getContainers().length >= Math.max(1, Number(neighborhoodPostLimit || 20)) &&
      neighborhoodProcessedCount >= Math.max(1, Number(neighborhoodPostLimit || 20))
    ) {
      return;
    }
    scanBusy = true;
    const runId = runGeneration;
    try {
      const allContainers = getContainers();
      const containers = activeSourceMode === "neighborhood"
        ? allContainers.slice(0, Math.max(1, Number(neighborhoodPostLimit || 20)))
        : allContainers;
      let scanned = 0;
      let accepted = 0;
      let rejected = 0;
      const reasons = {};
      const logs = [];
      for (const container of containers) {
        if (!isCurrentRun(runId) || !isScanning) break;
        scanned += 1;
        const result = await processContainer(container, runId);
        const reason = cleanText((result && result.reason) || "unknown");
        if (result && result.logEntry && shouldEmitScanLog(result.logEntry)) {
          logs.push(result.logEntry);
        }
        if (result && result.accepted) {
          accepted += 1;
        } else if (reason !== "stopped") {
          rejected += 1;
          reasons[reason] = (reasons[reason] || 0) + 1;
        }
      }
      if (activeSourceMode === "neighborhood") {
        neighborhoodProcessedCount = Math.max(neighborhoodProcessedCount, scanned);
        neighborhoodAcceptedCount += accepted;
      }
      if (!isCurrentRun(runId) || !isScanning) return;
      chrome.runtime.sendMessage({
        type: "SCAN_DIAGNOSTICS",
        diagnostics: { scanned, accepted, rejected, reasons },
      }, () => {
        if (chrome.runtime.lastError) {}
      });
      if (logs.length) {
        chrome.runtime.sendMessage({
          type: "ADD_SCAN_LOGS",
          logs,
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (err) {
      derror("[SCAN] failed", err);
    } finally {
      scanBusy = false;
    }
  }
  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(
      debounce(() => {
        if (isScanning) scanVisibleNow();
      }, getObserverDebounceMs())
    );
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }
  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }
  function applyConfig(config = {}) {
    useSmartMatch = !!config.useSmartMatch;
    activeSourceMode = resolveSourceMode(config);
    neighborhoodPostLimit = Math.max(1, Number(config.neighborhoodPostLimit || 20));
    userKeywords = uniqueNormalizedKeywords(config.keywords || []);
    userExcludeKeywords = uniqueNormalizedKeywords(config.excludeKeywords || []);
    keywordMatcher = createKeywordMatcher(userKeywords, { mode: "broad" });
    excludeKeywordMatcher = createKeywordMatcher(userExcludeKeywords, { mode: "exact" });
    timeRangeHours = Number(config.timeRangeHours || 24);
    customRangeStart = cleanText(config.customRangeStart || "") || null;
    customRangeEnd = cleanText(config.customRangeEnd || "") || null;
    scrollSpeed = cleanText(config.scrollSpeed || "normal").toLowerCase() || "normal";
    scrollDelayMs = Math.max(250, Number(config.scrollDelayMs || 1000));
    if (activeSourceMode === "neighborhood") {
      if (scrollSpeed !== "fast") scrollSpeed = "fast";
      scrollDelayMs = Math.min(scrollDelayMs, 420);
    }
    manualIncogAccountName = cleanText(config.incogAccountName || "");
    manualAccountArea = cleanText(config.accountArea || "");
  }
  function getLastContainerSignature(isSearch) {
    const containers = isSearch ? getSearchContainers() : getRecentContainers();
    const last = containers[containers.length - 1];
    if (!last) return "";
    if (isSearch) return getSearchContainerKey(last, containers.length - 1);
    return cleanText(
      last.getAttribute("data-testid") ||
      last.id ||
      extractPostLink(last) ||
      textFromNode(last).slice(0, 140)
    ).slice(0, 200);
  }
  function getScrollProgressSnapshot(isSearch) {
    const containers = isSearch ? getSearchContainers() : getRecentContainers();
    return {
      height: getDocumentScrollHeight(),
      count: containers.length,
      lastSignature: getLastContainerSignature(isSearch),
      scrollY: window.scrollY || window.pageYOffset || 0,
    };
  }
  function hasScrollContentChanged(previousSnapshot, nextSnapshot) {
    return nextSnapshot.height > previousSnapshot.height ||
      nextSnapshot.count > previousSnapshot.count ||
      (!!nextSnapshot.lastSignature && nextSnapshot.lastSignature !== previousSnapshot.lastSignature);
  }
  function hasPostListChanged(previousSnapshot, nextSnapshot) {
    return nextSnapshot.count > previousSnapshot.count ||
      (!!nextSnapshot.lastSignature && nextSnapshot.lastSignature !== previousSnapshot.lastSignature);
  }
  function isAtLoadedPageBoundary(previousSnapshot, nextSnapshot, expectedStepPx) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const remainingPx = nextSnapshot.height - (nextSnapshot.scrollY + viewportHeight);
    const bottomTolerancePx = Math.max(100, Math.min(220, Math.floor((window.innerHeight || 600) * 0.18)));
    const actualMovementPx = Math.max(0, nextSnapshot.scrollY - previousSnapshot.scrollY);
    const minimumExpectedMovementPx = Math.max(80, Math.floor(Number(expectedStepPx || 0) * 0.35));
    return remainingPx <= bottomTolerancePx || actualMovementPx < minimumExpectedMovementPx;
  }
  function isPostLoaderVisible() {
    const selectors = [
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '[data-testid*="loading"]',
      '[data-testid*="spinner"]',
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(","))).slice(0, 20);
    return nodes.some((node) => {
      if (!node || !node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      if (rect.bottom <= 0 || rect.top >= viewportHeight) return false;
      if (rect.bottom < viewportHeight * 0.45) return false;
      if (node.getAttribute("aria-busy") === "true" && rect.height > viewportHeight * 0.75) return false;
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    });
  }
  async function waitForScrollProgress(isSearch, previousSnapshot, baseWaitMs, _stalledRounds, runId, expectedStepPx) {
    const startedAt = Date.now();
    const minimumWaitMs = Math.max(450, Math.min(1800, Number(baseWaitMs) || 1000));
    const maxWaitMs = Math.max(POST_LOAD_MAX_WAIT_MS, minimumWaitMs * 4);
    let latestSnapshot = previousSnapshot;
    let lastContentChangeAt = startedAt;
    let progressed = false;
    let waitingForPostLoadSince = 0;

    while (Date.now() - startedAt < maxWaitMs) {
      if (!autoScrollActive || !isCurrentRun(runId)) {
        return { progressed: false, snapshot: getScrollProgressSnapshot(isSearch), cancelled: true };
      }
      await sleep(POST_LOAD_POLL_MS);
      if (!autoScrollActive || !isCurrentRun(runId)) {
        return { progressed: false, snapshot: getScrollProgressSnapshot(isSearch), cancelled: true };
      }

      const now = Date.now();
      const next = getScrollProgressSnapshot(isSearch);
      if (hasScrollContentChanged(latestSnapshot, next)) {
        latestSnapshot = next;
        lastContentChangeAt = now;
      }
      if (hasPostListChanged(previousSnapshot, next)) progressed = true;

      const loaderVisible = isPostLoaderVisible();
      const elapsedMs = now - startedAt;
      const boundaryCheckReady = elapsedMs >= Math.min(600, minimumWaitMs);
      const atLoadedBoundary = boundaryCheckReady &&
        isAtLoadedPageBoundary(previousSnapshot, next, expectedStepPx);
      if (!waitingForPostLoadSince && (loaderVisible || atLoadedBoundary)) {
        waitingForPostLoadSince = now;
        dlog("[SCROLL] waiting for posts to load", {
          loaderVisible,
          atLoadedBoundary,
          count: next.count,
          remainingPx: Math.max(0, next.height - (next.scrollY + (window.innerHeight || 0))),
        });
      }
      if (
        progressed &&
        elapsedMs >= minimumWaitMs &&
        !loaderVisible &&
        now - lastContentChangeAt >= POST_LOAD_SETTLE_MS
      ) {
        return { progressed: true, snapshot: next, cancelled: false };
      }

      if (!progressed && waitingForPostLoadSince) {
        const loadWaitLimitMs = loaderVisible ? POST_LOAD_MAX_WAIT_MS : POST_LOAD_BOTTOM_WAIT_MS;
        if (now - waitingForPostLoadSince >= loadWaitLimitMs) {
          return { progressed: false, snapshot: next, cancelled: false };
        }
        continue;
      }
      if (!progressed && elapsedMs >= minimumWaitMs) {
        return { progressed: false, snapshot: next, cancelled: false };
      }
    }

    const finalSnapshot = getScrollProgressSnapshot(isSearch);
    return {
      progressed: progressed || hasPostListChanged(previousSnapshot, finalSnapshot),
      snapshot: finalSnapshot,
      cancelled: false,
    };
  }
  async function runAdaptiveAutoScroll(isSearch, runId) {
    const baseStepPx = isSearch
      ? (scrollSpeed === "fast" ? Math.max(760, Math.floor(window.innerHeight * 0.9))
        : scrollSpeed === "slow" ? Math.max(260, Math.floor(window.innerHeight * 0.42))
        : Math.max(420, Math.floor(window.innerHeight * 0.62)))
      : (scrollSpeed === "fast" ? Math.max(900, Math.floor(window.innerHeight * 1.05))
        : scrollSpeed === "slow" ? Math.max(320, Math.floor(window.innerHeight * 0.5))
        : Math.max(560, Math.floor(window.innerHeight * 0.8)));
    let stalledRounds = 0;
    while (autoScrollActive && isCurrentRun(runId)) {
      if (!isScanning) return;
      if (
        activeSourceMode === "neighborhood" &&
        getRecentContainers().length >= Math.max(1, Number(neighborhoodPostLimit || 20)) &&
        neighborhoodProcessedCount >= Math.max(1, Number(neighborhoodPostLimit || 20))
      ) {
        dlog("[SCROLL] neighborhood limit reached, stopping local scroll loop", {
          loaded: getRecentContainers().length,
          processed: neighborhoodProcessedCount,
          limit: neighborhoodPostLimit,
        });
        autoScrollActive = false;
        return;
      }
      lastScrollActionAt = Date.now();
      const before = getScrollProgressSnapshot(isSearch);
      const jitter = Math.max(0.92, Math.min(1.08, 1 + ((stalledRounds % 3) - 1) * 0.05));
      const stepPx = Math.max(220, Math.floor(baseStepPx * jitter));
      window.scrollBy(0, stepPx);

      const progress = await waitForScrollProgress(isSearch, before, scrollDelayMs, stalledRounds, runId, stepPx);
      if (progress.cancelled) return;
      if (progress.progressed) {
        stalledRounds = 0;
        continue;
      }

      stalledRounds += 1;
      if (stalledRounds >= 2) {
        window.scrollBy(0, -Math.max(120, Math.floor(stepPx * 0.22)));
        await sleep(Math.max(220, Math.floor(scrollDelayMs * 0.45)));
        if (!autoScrollActive || !isCurrentRun(runId)) return;
        lastScrollActionAt = Date.now();
        window.scrollBy(0, Math.max(180, Math.floor(stepPx * 0.55)));
      }

      if (stalledRounds >= 4) {
        await sleep(Math.max(350, Math.floor(scrollDelayMs * 0.7)));
        if (!autoScrollActive || !isCurrentRun(runId)) return;
        stalledRounds = 0;
      }
    }
  }
  async function autoScrollRecent() {
    await runAdaptiveAutoScroll(false, runGeneration);
  }
  async function autoScrollSearch() {
    await runAdaptiveAutoScroll(true, runGeneration);
  }
  async function startAutoScroll() {
    if (autoScrollActive || !isScanning) return;
    const runId = runGeneration;
    autoScrollActive = true;
    try {
      if (isSearchPostsUrl(window.location.href)) {
        await waitForSearchResultsReady(15000, runId);
        if (!isScanning || !autoScrollActive || !isCurrentRun(runId)) return;
        await runAdaptiveAutoScroll(true, runId);
      } else {
        await runAdaptiveAutoScroll(false, runId);
      }
    } catch (err) {
      derror("[SCROLL] failed", err);
    } finally {
      if (isCurrentRun(runId)) autoScrollActive = false;
    }
  }
  function stopAutoScroll() {
    runGeneration += 1;
    autoScrollActive = false;
    dlog("[SCROLL] stopped");
  }
  function startScan(config = {}) {
    if (isScanning || autoScrollActive) stopScan();
    applyConfig(config);
    ensurePageHookInstalled();
    const sourceMode = resolveSourceMode(config);
    runGeneration += 1;
    const runId = runGeneration;
    currentScanSessionId = `scan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    loggedCardDecisions.clear();
    neighborhoodProcessedCount = 0;
    neighborhoodAcceptedCount = 0;
    seenInPage.clear();
    processingInPage.clear();
    isScanning = true;
    if (sourceMode === "recent" && !isSearchPostsUrl(window.location.href)) {
      forceRecentFeed(runId).catch((err) => derror("[RECENT] activation failed", err));
    }
    lastScrollActionAt = Date.now();
    startObserver();
    hydratePendingWriteQueue().then(() => {
      if (writeQueue.length) scheduleWriteFlush();
    }).catch((err) => derror("[WRITE] hydrate failed", err));
    scanVisibleNow();
    scanInterval = setInterval(() => {
      if (isScanning) scanVisibleNow();
    }, getActiveScanIntervalMs());
    dlog("[SCAN] started", {
      sourceMode,
      keywordCount: userKeywords.length,
      excludeCount: userExcludeKeywords.length,
      smartMatch: useSmartMatch,
    });
  }
  function stopScan() {
    stopAutoScroll();
    isScanning = false;
    stopScrollWatchdog();
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
    stopObserver();
    loggedCardDecisions.clear();
    neighborhoodProcessedCount = 0;
    neighborhoodAcceptedCount = 0;
    processingInPage.clear();
    dlog("[SCAN] stopped");
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "START_SCAN") {
      startScan(msg.config || {});
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "START_ACTIVITY") {
      startScan(msg.config || {});
      startAutoScroll();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "STOP_SCAN") {
      stopScan();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "STOP_ACTIVITY") {
      stopScan();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "START_SCROLL") {
      startAutoScroll();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "GET_SCAN_PROGRESS") {
      sendResponse({ ok: true, ...getScanProgressSnapshot() });
      return;
    }

    if (msg.type === "GET_NEIGHBORHOOD_CONTEXT") {
      sendResponse(getNeighborhoodPageContext());
      return;
    }

    if (msg.type === "HANDLE_NEIGHBORHOOD_FEED_ERROR") {
      sendResponse(tryRecoverNeighborhoodFeedError());
      return;
    }

    if (msg.type === "STOP_SCROLL") {
      stopAutoScroll();
      sendResponse({ ok: true });
      return;
    }
  });

})();
