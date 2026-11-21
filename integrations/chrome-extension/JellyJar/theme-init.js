(() => {
  const requested = new URLSearchParams(location.search).get("theme");
  const saved = localStorage.getItem("jellyjar-theme");
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = requested === "dark" || requested === "light"
    ? requested
    : saved === "dark" || saved === "light"
      ? saved
      : systemDark ? "dark" : "light";
})();
