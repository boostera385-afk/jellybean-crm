# JellyBean Visitor Presence — website team handoff

## What you are installing

Install **jellybean-presence-1.2.0.zip** once on each approved WordPress website.
The same ZIP works for all sites. Do not edit theme files or individual pages.
Keep the existing Crisp chat plugin/snippet active: this plugin does not replace
it, install another widget, or send messages itself.

**Important: upload the plugin ZIP itself.** If your email/download is an outer
handoff ZIP containing instructions and another ZIP, extract that outer archive
first. WordPress cannot install an archive containing only another ZIP. Version
1.2.0 supersedes the previous 1.0.0/1.1.0 handoffs. If already installed, upload
the new ZIP and choose **Replace current with uploaded**; saved settings remain.

### Visitor-side close button fix (Govee sites)

The sites contain a separate WPCode promotion iframe named
`isolated-govee-popup-frame`. Its transparent high-z-index hit area can overlap
Crisp. Version 1.2.0 disables only that legacy iframe. It does not hide Crisp,
mark messages read, or force the chat open/closed. This CSS protection activates
without configuring the presence relay. Install/activate the plugin on affected
Govee sites, clear caches, and leave the relay OFF until that site's enrollment.
Alternatively remove the old popup snippet in WPCode permanently; see
`CLOSE-BUTTON-FIX.txt`. Do not remove the actual Crisp widget snippet/plugin.

**Start with Fast Fix only.** Roll out other healthy sites after CRM operations
checks the first-site telemetry. Do not enable the two paused drywall workspaces.

This is a faster discovery path, not a guarantee of a five-second greeting.
Consent, widget loading, WordPress hosting, Crisp REST visibility/cache, quotas,
and network conditions can still add delay. Existing polling stays available.

## Before installation — coordinate with CRM operations

For **each site**, send CRM operations:

- The exact final HTTPS origin, e.g. `https://fastfixslidingdoorrepair.com`.
  Include `www` if that is the actual canonical hostname. No path or trailing `/`.
- The Crisp **Website ID** from the site's existing Crisp configuration.
  This is NOT the Marketplace plugin ID `4a0ce715-…`.

Operations enrolls that origin + Website ID and provides a **dedicated per-site
64-character signing key** through your approved password manager. Each site
must have its own key. Keys are NOT included in the ZIP or this guide.

Never enter a Crisp API token, Marketplace webhook secret, or Supabase service
key here. Never email credentials, commit them, or include them in screenshots.

Requirements: WordPress 6.2+, PHP 7.4+ (use a currently supported PHP version),
HTTPS, functioning WordPress REST API, existing Crisp widget, and outbound HTTPS
from PHP to `fjscqsatzsmfivpczaud.supabase.co`.

## WordPress administrator steps

1. Back up the site and follow your normal plugin change process.
2. Open **Plugins → Add New Plugin → Upload Plugin**.
3. Choose `jellybean-presence-1.2.0.zip` → **Install Now → Activate**.
4. Open **Settings → JellyBean Presence**.
5. Enter this site's **Crisp Website ID** and its dedicated signing key.
   Existing keys are never displayed again; an empty password field keeps the
   saved value. Operations may instead define `JELLYBEAN_PRESENCE_KEY` in
   `wp-config.php` using your secret deployment process (never publish that file).
6. Tick **Enable arrival relay** and click **Save Changes**.
7. Confirm the displayed origin matches the one enrolled by operations exactly.
   Click **Test backend connection**. Expect **Connected**. This checks the key,
   origin, and backend enrollment without creating visitors or sending messages.
8. Clear the page/CDN cache once. Exclude the `jellybean-presence` script handle
   and `assets/presence.js` from delay-until-interaction features. Do not defer
   the existing Crisp widget until a click if silent-visitor greeting is required.
9. Allow same-origin POST requests to `/wp-json/jellybean/v1/arrival` through your
   security plugin/WAF. Do not cache that POST endpoint. Do not bypass consent.

Multisite: install the ZIP once at network level if desired, but configure each
subsite separately. No automatic network-wide settings or secret sharing.

### First site: Fast Fix

- Website: `https://fastfixslidingdoorrepair.com`
- Crisp Website ID: `87065a95-c96e-4f0b-867d-a4bbb47e08ec`
- Key: obtain securely from CRM operations. It is not the Crisp webhook secret.

## Acceptance test — do not skip

1. Close all incognito windows to remove the previous test session.
2. Open the site in a new incognito window. Complete consent if required; do not
   type into chat. Note the time/timezone and time until the greeting is visible.
3. In browser DevTools → Network, filter `jellybean/v1/arrival`.
   Expect a same-origin POST returning **202**, or **200** for a suppressed duplicate.
   The browser request must contain only `session_id` + `request_id` and no key.
4. Send operations the site origin, timestamp/timezone, HTTP status, and observed
   greeting delay. Do not send cookies or credentials. A 202 means the hint was
   accepted, NOT that a message was displayed.
5. Operations checks signed receipt → expedited Crisp identity read → greeting
   job → accepted send, then compares with the visible greeting time. Only then
   approve rollout. A previously greeted session may correctly receive no new
   greeting because the normal conversation/cooldown rules still apply.
6. To distinguish widget loading from relay delays, inspect
   `window.JellyBeanPresenceStatus` in the browser console. It contains local
   timestamps and a phase only, no signing key or message text. `messageReceivedAt`
   is a Crisp SDK event, not proof that a person saw the message; record visible
   display time separately. No arrival request should occur before Crisp consent.

Troubleshooting:

| Symptom                  | Check                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| No arrival request       | Plugin enabled; ID matches `CRISP_WEBSITE_ID`; Crisp consent/session loaded; no JS delay/WAF block; test a genuinely fresh session |
| 401/403 from WordPress   | Site origin mismatch (www/redirect/proxy), disabled relay, missing key                                                             |
| 503                      | Incorrect or unenrolled key/origin, PHP outbound HTTPS blocked, backend unavailable; ask operations                                |
| 429                      | Rate protection; stop repeated reloads, leave polling active                                                                       |
| 202 but slow/no greeting | Operations checks Crisp identity visibility/cache, active poll lease, API quota, prior conversations and greeting cooldown         |

No synthetic visitors or fake greetings should be created to test on production.

## Rollback and privacy

Untick **Enable arrival relay** or deactivate **JellyBean Visitor Presence**.
Keep the original Crisp plugin active. Existing polling and Marketplace hooks
continue unchanged. Clear the page cache again. Ask operations to disable that
site's bridge or rotate/revoke its dedicated key.

The relay switch stops arrival signals only. Deactivating the entire plugin also
removes the legacy-popup CSS protection; remove the old WPCode popup permanently
if it must remain fixed after deactivation.

Uninstalling removes this plugin's saved settings/key for the current site.
Short-lived WordPress rate/dedup transients expire naturally. On multisite,
remove saved settings separately on each configured subsite.

The plugin sends only the Crisp Website ID, session ID, request ID, and request
timestamp through HTTPS. It sends no name, email, IP address, page title, or URL
to JellyBean. A local salted IP hash is used for WordPress rate limiting.
Browser sessionStorage suppresses repeat submissions for two minutes. Backend
dedup records prune session IDs older than seven days (daily cleanup can add up to
one day). Existing Crisp
consent is respected: nothing is signaled until Crisp exposes a loaded session.
Update your privacy/consent inventory as required by your organization.

## Workspace checklist (verify the site/ID before enrollment)

| Workspace                     | Crisp Website ID                       | Rollout               |
| ----------------------------- | -------------------------------------- | --------------------- |
| Fast Fix Sliding door Repair  | `87065a95-c96e-4f0b-867d-a4bbb47e08ec` | First-site canary     |
| Arrow Head Sprinkler          | `da696a9f-e290-43f0-88d9-dd13cb60c939` | After canary          |
| Christmas Lights Specialist   | `f8160ad6-3b1f-4a25-bb00-75b3d762e07c` | After canary          |
| Fast Patch Drywall Repair LLC | `3b403129-ac24-4684-a0dc-f363e91802fd` | After canary          |
| Govee Installation            | `8c7f47a7-3a62-44d6-a374-03aec51e4178` | After canary          |
| Govee Installer               | `118248af-9a62-496f-a62f-0125583e5d0b` | After canary          |
| Govee Lights                  | `239b1e9c-713f-4c77-9c84-8f1f62657a2f` | After canary          |
| Light It Up Av and Turf       | `75d8f979-76fc-4a4d-a5ae-da9611167758` | After canary          |
| Olympus Sliding Doors         | `6255b9b5-6ae1-4101-b402-07e2d8766648` | After canary          |
| Sisu Christmas Lights         | `02fd579f-3320-48d7-b84f-653947fa0c0b` | After canary          |
| Sliding Door Squad            | `26093fd1-c85a-4cea-a8c5-f2bbd6f927bc` | After canary          |
| Drywall Repair Services LLC   | `790c7fb6-1841-4e64-8b7b-847879a2b295` | HOLD — Crisp HTTP 404 |
| Wall Tech Drywall Repair      | `55813cfd-7cdb-46a6-8d12-13b3bce54d69` | HOLD — Crisp HTTP 404 |
