(() => {
  "use strict";
  if (window.__jellyBeanPresenceStarted) return;
  window.__jellyBeanPresenceStarted = true;
  const config = window.JellyBeanPresence;
  if (!config || new URL(config.endpoint, location.href).origin !== location.origin) return;
  // Local-only diagnostics: no message content, session IDs or keys are exposed.
  const status = (window.JellyBeanPresenceStatus = {
    phase: "waiting_for_crisp",
    scriptStartedAt: Date.now(),
  });
  const sessionPattern = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let queue,
    inFlight = false,
    lastSession = null,
    lastSent = 0,
    retries = 0;
  let lastRequest = null;
  let retryAt = 0;

  async function arrival(session) {
    if (window.CRISP_WEBSITE_ID && window.CRISP_WEBSITE_ID !== config.websiteId)
      status.phase = "website_id_mismatch";
    if (
      document.visibilityState !== "visible" ||
      window.CRISP_WEBSITE_ID !== config.websiteId ||
      !sessionPattern.test(session) ||
      inFlight ||
      Date.now() < retryAt ||
      retries >= 3
    )
      return;
    const storageKey = `jb-arrival:${config.websiteId}:${session}`;
    let previous = lastSession === session ? lastSent : 0;
    try {
      previous = Math.max(previous, Number(sessionStorage.getItem(storageKey)) || 0);
    } catch {
      /* optional storage */
    }
    if (Date.now() - previous < 120000) return;
    if (!window.crypto || !crypto.randomUUID) return;
    // Reuse the ID for ambiguous retries; no duplicate work on the backend.
    if (!lastRequest || lastRequest.session !== session) {
      lastRequest = { session, id: crypto.randomUUID() };
      retries = 0;
    }
    inFlight = true;
    status.phase = "sending_arrival";
    status.sessionReadyAt = status.sessionReadyAt || Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        mode: "same-origin",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session, request_id: lastRequest.id }),
        signal: controller.signal,
      });
      if (response.ok) {
        status.phase = "arrival_accepted";
        status.arrivalAcceptedAt = Date.now();
        lastSession = session;
        lastSent = Date.now();
        lastRequest = null;
        retries = 0;
        try {
          sessionStorage.setItem(storageKey, String(lastSent));
        } catch {
          /* optional storage */
        }
      } else if (response.status >= 500) {
        status.phase = "relay_unavailable";
        retries++;
        retryAt = Date.now() + 1500 * retries;
        if (retries < 3) setTimeout(() => arrival(session), 1500 * retries);
      } else {
        status.phase = `relay_http_${response.status}`;
        retries = 3;
      } // 4xx/429: stop; polling is the fallback.
    } catch {
      status.phase = "relay_network_error";
      retries++;
      retryAt = Date.now() + 1500 * retries;
      if (retries < 3) setTimeout(() => arrival(session), 1500 * retries);
    } finally {
      clearTimeout(timeout);
      inFlight = false;
    }
  }

  function attach() {
    // Do not create/reset $crisp or inject another chat script. Some WordPress
    // Crisp plugins replace the queue while loading; reattach to the new object.
    if (window.$crisp && typeof window.$crisp.push === "function" && window.$crisp !== queue) {
      queue = window.$crisp;
      queue.push(["on", "session:loaded", arrival]);
      queue.push([
        "on",
        "message:received",
        () => {
          status.messageReceivedAt = Date.now();
        },
      ]);
    }
    try {
      if (window.$crisp && typeof window.$crisp.get === "function") {
        arrival(window.$crisp.get("session:identifier"));
      }
    } catch {
      /* SDK not ready; the session:loaded event remains registered. */
    }
  }
  attach();
  // Late consent may load Crisp after the bounded readiness timer has stopped.
  // Preserve any existing integration's callback; never bypass consent/loading.
  const previousReady = window.CRISP_READY_TRIGGER;
  window.CRISP_READY_TRIGGER = function (...args) {
    try {
      if (typeof previousReady === "function") previousReady.apply(this, args);
    } finally {
      attach();
    }
  };
  // Bounded readiness check supports both early and late SDK loading. No network
  // heartbeat: successful arrivals are suppressed across page navigation.
  const timer = setInterval(attach, 250);
  setTimeout(() => clearInterval(timer), 120000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) attach();
  });
  window.addEventListener("pageshow", attach);
})();
