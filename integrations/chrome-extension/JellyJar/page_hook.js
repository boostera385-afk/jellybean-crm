(function () {
  if (window.__ndPageHookInstalled) return;
  window.__ndPageHookInstalled = true;

  function normalizePostUrl(url) {
    try {
      const u = new URL(String(url || ""), location.origin);
      const host = (u.hostname || "").toLowerCase();
      if (!(host === "nextdoor.com" || host.endsWith(".nextdoor.com"))) return "";
      const path = (u.pathname || "").replace(/\/+$/g, "");
      if (!path.startsWith("/p/")) return "";
      return `${u.origin}${path}`;
    } catch {
      return "";
    }
  }

  function deepFindPostUrls(obj, found) {
    if (!obj) return found;

    if (typeof obj === "string") {
      const matches = obj.match(
        /https?:\/\/(?:www\.)?(?:[\w-]+\.)?nextdoor\.com\/p\/[A-Za-z0-9_-]+(?:\?[^"'\\s<>]*)?/gi
      );
      if (matches) found.push(...matches);
      return found;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) deepFindPostUrls(item, found);
      return found;
    }

    if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        deepFindPostUrls(obj[key], found);
      }
    }

    return found;
  }

  function emitUrls(rawUrls) {
    if (!rawUrls || !rawUrls.length) return;

    const cleanUrls = [];
    const seen = new Set();

    for (const raw of rawUrls) {
      const clean = normalizePostUrl(raw);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      cleanUrls.push(clean);
    }

    if (!cleanUrls.length) return;

    window.postMessage(
      {
        source: "nd-page-hook",
        type: "ND_POST_URLS_FOUND",
        urls: cleanUrls,
      },
      "*"
    );
  }

  function inspectPayload(payload) {
    try {
      const found = deepFindPostUrls(payload, []);
      if (found.length) emitUrls(found);
    } catch {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);

    try {
      const clone = res.clone();
      const ct = clone.headers.get("content-type") || "";

      if (ct.includes("application/json")) {
        clone.json().then(inspectPayload).catch(() => {});
      } else {
        clone.text().then(inspectPayload).catch(() => {});
      }
    } catch {}

    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ndTrackedUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const ct = this.getResponseHeader("content-type") || "";
        if (ct.includes("application/json") && typeof this.responseText === "string") {
          inspectPayload(JSON.parse(this.responseText));
        } else if (typeof this.responseText === "string") {
          inspectPayload(this.responseText);
        }
      } catch {}
    });

    return origSend.apply(this, args);
  };
})();