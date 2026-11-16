(() => {
  "use strict";
  if (window.__jellyBeanPreviewStarted) return;
  window.__jellyBeanPreviewStarted = true;
  const root = document.documentElement;
  let queue, timer;
  const key = () => `jb-preview:${window.CRISP_WEBSITE_ID || "default"}`;
  let dismissed = false;
  try {
    dismissed = sessionStorage.getItem(key()) === "dismissed";
  } catch {
    /* Storage is optional; never block chat. */
  }
  function hide() {
    clearTimeout(timer);
    root.dataset.jbChatPreview = "hidden";
    dismissed = true;
    try {
      sessionStorage.setItem(key(), "dismissed");
    } catch {
      /* Storage is optional. */
    }
  }
  function show() {
    clearTimeout(timer);
    root.dataset.jbChatPreview = "visible";
    dismissed = false;
    try {
      sessionStorage.removeItem(key());
    } catch {
      /* Storage is optional. */
    }
    if (!document.hidden) timer = setTimeout(hide, 8000);
  }
  function attach() {
    const sdk = window.$crisp;
    if (!sdk || typeof sdk.push !== "function" || sdk === queue) return;
    queue = sdk;
    root.dataset.jbChatPreview = dismissed ? "hidden" : "visible";
    // Presentation only: never send/show a synthetic message, reset the
    // session, unregister another integration's events, or mark messages read.
    sdk.push(["on", "message:received", show]);
    sdk.push(["on", "chat:opened", hide]);
    sdk.push(["on", "message:sent", hide]);
    // Covers restored unread history, which need not emit message:received.
    sdk.push([
      "on",
      "session:loaded",
      () => {
        if (!dismissed) show();
      },
    ]);
    if (!dismissed) show();
  }
  attach();
  const previousReady = window.CRISP_READY_TRIGGER;
  window.CRISP_READY_TRIGGER = function (...args) {
    try {
      if (typeof previousReady === "function") previousReady.apply(this, args);
    } finally {
      attach();
    }
  };
  const readiness = setInterval(attach, 250);
  setTimeout(() => clearInterval(readiness), 120000);
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden && !dismissed) show();
  });
})();
