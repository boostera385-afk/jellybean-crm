// JellyJar — settings from the JellyBean CRM.
//
// This file is replaced when the extension is downloaded from the CRM
// (Browser Profiles → Extension). The CRM writes the searches and keyword
// lists saved under "Extension settings" into it, so a fresh download always
// starts with the team's current list.
//
// When it is null (as in the source repository), the extension uses its
// built-in searches and keyword lists.
//
// Shape written by the CRM:
// {
//   revision: 3,                       // bumps on every save in the CRM
//   generatedAt: "2026-11-21T10:00:00.000Z",
//   searches: [{ label: "Painting", query: "Painting", durationSeconds: 60 }],
//   includeKeywords: ["handyman", ...],
//   excludeKeywords: ["sponsored", ...]
// }
var JELLYJAR_CRM_CONFIG = null;
