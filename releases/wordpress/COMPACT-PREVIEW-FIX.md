# Single-message preview fix (v1.3.0)

Install `jellybean-presence-1.3.0.zip` using WordPress **Plugins → Add New →
Upload Plugin**, replacing the existing version. Preserve the existing Crisp
plugin and saved relay settings. No new signing key is required.

On the affected website only:

1. Open **Settings → JellyBean Presence**.
2. Enable **Compact message previews** and save. Arrival relay enrollment is
   optional for this presentation setting.
3. Remove the legacy Govee popup snippet in WPCode. The plugin also retains the
   existing narrowly scoped protection against its overlapping iframe.
4. Use CRM as the only automated greeting sender; disable any duplicate
   greetings in Crisp campaigns, other plugins or website snippets.
5. Clear WordPress/CDN page caches.

Expected behavior:

- First visit: existing CRM first greeting.
- Verified return: existing CRM welcome-back greeting (not on every page reload;
  existing away/cooldown/replied-visitor safeguards still apply).
- Only the latest message appears outside the closed chat, for eight seconds.
- Afterward, the launcher and its actual Crisp unread count remain; opening chat
  shows the full history. Hiding a preview does not mark messages read.
- A genuinely new incoming message may show a new eight-second preview.

Test in a fresh browser profile, then a verified return, on desktop and mobile.
Check opening chat before timeout, page navigation after dismissal, the close
control, unread count and a real operator reply. The badge count is determined by
Crisp, not forced to 1 or 2 by the plugin.

Rollback: uncheck **Compact message previews**, save and clear caches.
This leaves greeting delivery, unread state and conversation history untouched.

Local desktop/mobile fixture tests passed. Live website verification and
WordPress installation are still required; this release has not been deployed.
The single-message CSS adapter targets Crisp v4.18.3 vendor internals and must
be checked after Crisp changes its markup.
