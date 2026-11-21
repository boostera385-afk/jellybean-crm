// JellyJar — applies the CRM settings in crm-config.js on top of the built-in
// defaults. Loaded after defaults.js, include-defaults.js and crm-config.js in
// both the background worker and the popup.
//
// Sets:
//   DEFAULT_INCLUDE_KEYWORDS / DEFAULT_EXCLUDE_KEYWORDS — replaced by the CRM
//     lists when the CRM sent a non-empty list.
//   JELLYJAR_CRM_SEARCHES — the CRM search rotation, or null for the built-in one.
//   JELLYJAR_CRM_REVISION — the CRM settings revision, or 0 when there is none.

var JELLYJAR_CRM_SEARCHES = null;
var JELLYJAR_CRM_REVISION = 0;

(function applyJellyJarCrmConfig() {
  var MIN_SEARCH_SECONDS = 10;
  var MAX_SEARCH_SECONDS = 3600;

  function clean(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function keywordList(value) {
    if (!Array.isArray(value)) return null;
    var seen = new Set();
    var out = [];
    value.forEach(function (item) {
      var keyword = clean(item);
      var key = keyword.toLowerCase();
      if (!keyword || seen.has(key)) return;
      seen.add(key);
      out.push(keyword);
    });
    return out.length ? out : null;
  }

  var cfg = globalThis.JELLYJAR_CRM_CONFIG;
  if (!cfg || typeof cfg !== "object") return;

  var include = keywordList(cfg.includeKeywords);
  if (include) DEFAULT_INCLUDE_KEYWORDS = include;

  var exclude = keywordList(cfg.excludeKeywords);
  if (exclude) DEFAULT_EXCLUDE_KEYWORDS = exclude;

  if (Array.isArray(cfg.searches)) {
    var searches = cfg.searches
      .map(function (entry) {
        var query = clean(entry && entry.query);
        if (!query) return null;
        var seconds = Math.round(Number(entry.durationSeconds) || 60);
        return {
          label: clean(entry.label) || query,
          query: query,
          durationSeconds: Math.min(MAX_SEARCH_SECONDS, Math.max(MIN_SEARCH_SECONDS, seconds)),
        };
      })
      .filter(Boolean);
    if (searches.length) JELLYJAR_CRM_SEARCHES = searches;
  }

  JELLYJAR_CRM_REVISION = Math.max(0, Math.floor(Number(cfg.revision) || 0));

  globalThis.DEFAULT_INCLUDE_KEYWORDS = DEFAULT_INCLUDE_KEYWORDS;
  globalThis.DEFAULT_EXCLUDE_KEYWORDS = DEFAULT_EXCLUDE_KEYWORDS;
})();
