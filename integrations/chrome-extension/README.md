# JellyJar Chrome extension

Captures Nextdoor posts and sends them to the CRM at
`/api/public/nextdoor-leads` (see `JellyJar/CRM_WEBHOOK_CONTRACT.md`).

## Searches and keywords come from the CRM

Admins edit what the extension searches in **Browser Profiles → Extension
settings** (table `public.extension_settings`):

- **Searches**: each one is a Nextdoor search (service name, search terms, run
  time in seconds). The extension runs the ones that are on, in order, once per run.
- **Include keywords**: a post must contain one of these to be captured.
- **Exclude keywords**: posts containing any of these are skipped.

When someone clicks **Extension** on that page, the CRM downloads
`crm-downloads/JellyJar.zip`, writes the saved settings into its
`JellyJar/crm-config.js`, and hands over `JellyJar.zip`. So:

- A new download always has the current settings.
- An installed extension keeps its settings until it is downloaded and loaded
  again. Changing settings in the CRM does not update it.
- Keyword edits made in the extension popup stay until a download with newer
  CRM settings is loaded; that download replaces them.

In this repository `crm-config.js` is `null`, so a copy loaded straight from
here uses the built-in searches and keyword lists (`background.js`,
`defaults.js`, `include-defaults.js`).

## Releasing a new version

1. Raise `version` in `JellyJar/manifest.json`.
2. Zip the `JellyJar` folder (the zip must contain `JellyJar/manifest.json`).
3. Upload it to Supabase Storage as `crm-downloads/JellyJar.zip`,
   replacing the old file.

Load it in Chrome from `chrome://extensions` → Developer mode → Load unpacked
(or Reload on an existing copy).
