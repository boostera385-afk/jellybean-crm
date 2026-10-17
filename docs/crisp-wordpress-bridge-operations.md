# WordPress arrival bridge — CRM operations

## Trust boundary

Browser → same-origin WordPress REST route → per-site HMAC-authenticated Edge
Function → durable pending flag → existing worker → budgeted Crisp identity
read → existing greeting queue/send safeguards.

An anonymous browser request is NOT authenticated visitor presence. Origin checks
are CSRF/friction controls, not proof of a human visitor: clients can spoof them.
A signed WordPress hint only accelerates verification. Never turn it directly
into `session:update_availability`, a visitor upsert, or a greeting job.

Site key is generated independently of Crisp/plugin/Supabase credentials and
stored encrypted in Vault. WordPress keeps it in a non-autoloaded option, or a
server-side `JELLYBEAN_PRESENCE_KEY` constant. Never return it via REST or inline
JavaScript. Back up and secure WordPress options as credentials. Only service_role
can read/provision bridges. The Edge Function has JWT verification disabled
because it verifies its own HMAC; never remove that verification.

## Provision a site (trusted SQL/MCP role only)

After matching the existing Website ID to the website's Crisp configuration and
confirming the canonical HTTPS origin, call:

```sql
-- Generate a unique key using pgcrypto, inside a trusted operations session.
-- Verify the installed pgcrypto schema before using this example.
select public.crisp_provision_site_bridge(
  'THE-EXISTING-CRISP-WEBSITE-UUID',
  'https://canonical-site.example',
  encode(extensions.gen_random_bytes(32),'hex')
);
```

The key is saved in Vault as `crisp_site_bridge_<website-id>`. A trusted operator
retrieves it from Vault in the dashboard and shares it with the website admin
through the approved password manager. Do not print it into logs, Git, tickets,
email, chat, plugin ZIPs or screenshots. Provisioning an existing site rotates
its key immediately; coordinate the WordPress update. It does not re-enable a
disabled workspace, bypass the presence breaker, or change `presence_feed`.

Keep both HTTP-404 workspaces out of rollout even if an hourly probe temporarily
unpauses them. No mass enrollment based on workspace names or guessed domains.

### Prepared canary

Fast Fix (`87065a95-c96e-4f0b-867d-a4bbb47e08ec`) is enrolled for
`https://fastfixslidingdoorrepair.com`. Its key is in Vault under
`crisp_site_bridge_87065a95-c96e-4f0b-867d-a4bbb47e08ec`; retrieve/share only through
the secure operations process above. Other sites are not enrolled until their
canonical origins are confirmed. The new endpoint and worker update are deployed;
WordPress installation and real navigation-to-visible-greeting testing remain pending.

## Rate limits and recovery

- Exact HTTPS origin + per-site signature over `timestamp + '.' + raw JSON`.
- Timestamp within ±60 seconds; hosts must have synchronized clocks.
- Request JSON ≤2 KiB; UUID Website/request IDs; valid Crisp session format.
- Per-session duplicate window: 2 minutes; same request ID remains a duplicate.
- Per-site backend cap: 20 accepted hints/minute and 200/hour, serialized by row locks.
- Acceleration at most once per 2 seconds/workspace; active leases, pause/cooldown,
  and `crisp_reserve_request` background budget still apply. Regular polling keeps
  its adaptive cadence and full snapshot absence validation.
- WordPress best-effort per-IP limit: 10 requests/minute; uses REMOTE_ADDR, not
  spoofable forwarded headers. Behind some proxies this may group visitors;
  backend caps remain authoritative and polling remains the fallback.
- Browser retries at most twice on network/5xx, same request ID, with backoff.
  4xx/429 stops submissions for that page. No network heartbeat.
- PHP transport timeout: 5 seconds; no redirect following; TLS verification on.
- Arrival records track attempts, verification, next check, and expiry. A cached
  or empty read does not consume the hint permanently: at most three checks over
  30 seconds are eligible. The handler attempts up to three worker wakes with
  two-second backoff; existing leases, quotas, and breaker checks still apply.
  Cron recovers failed wake-ups. Exhausted/expired hints fall back to polling.
- Arrival-target reads search up to three pages for the specific pending session
  IDs. A later page, cache delay, or blocked consent can still prevent instant
  detection. No unsupported cache-busting, fake presence or unbounded retries.
- Signed `action=check` requests verify enrollment without creating arrivals,
  visitors or greeting jobs. WordPress exposes the action only through an
  administrator capability + nonce-protected form, throttled to once/10 seconds.
- Revisit greetings require a verified offline-to-online boundary after at least
  two minutes away, plus the existing cooldown. Continuous visits and metadata
  updates never establish a new visit. The visit watermark is preserved across
  reloads; visitors who have replied remain suppressed.

## Verify

```sql
select w.workspace_name,b.enabled,b.origin,b.last_received_at,
       w.site_presence_requested_at,w.site_presence_claimed_at,
       w.site_presence_pending,w.visitor_identity_checked_at,w.visitor_sync_error
from public.crisp_workspaces w
join public.crisp_site_bridges b using(crisp_website_id);
```

Correlate `crisp_site_arrivals.received_at` and its session ID with greeting job
`created_at`/`sent_at`. These are server-side timestamps, not navigation time or
proof of visible rendering. The website team must measure navigation → visible
greeting separately. Backend 202 indicates a durable hint, not a sent greeting.

```sql
select w.workspace_name,a.received_at,a.attempts,a.verified_at,a.next_attempt_at,a.expires_at,
       case when a.verified_at is not null then 'verified'
            when a.expires_at<=now() or a.attempts>=3 then 'polling_fallback'
            else 'awaiting_crisp_identity' end as verification_status
from public.crisp_site_arrivals a
join public.crisp_workspaces w using(crisp_website_id)
order by a.received_at desc limit 50;
```

Daily `crisp-site-arrival-cleanup` removes dedup rows older than seven days.
Use existing Supabase log retention for coarse outcome logs; no signing keys,
raw request bodies, IP addresses or session IDs are logged by the new handler.

Disable with:

```sql
update public.crisp_site_bridges set enabled=false
where crisp_website_id='THE-EXISTING-CRISP-WEBSITE-UUID';
update public.crisp_workspaces set site_presence_pending=false
where crisp_website_id='THE-EXISTING-CRISP-WEBSITE-UUID';
```

Do not disable normal polling or marketplace hooks. Disabling the bridge stops
future authenticated hints; it cannot recall a greeting already queued/sent.

## Packaging and testing

- `powershell -File scripts/package-wordpress-presence.ps1`
- `bunx vitest run src/lib/crisp-site-arrival.test.ts`
- `php -l integrations/wordpress/jellybean-presence/jellybean-presence.php`
- `php integrations/wordpress/tests/relay-test.php`
- `supabase/tests/crisp-site-bridge.sql` (transactional regression suite)
- `supabase/tests/crisp-arrival-recovery.sql` (bounded retries/cache/target checks)
- `bun run test:crisp-sql` runs the checked-in offline PGlite harness.
- Real WordPress installer + activation + REST tests: run pinned Playground CLI
  3.1.58 `run-blueprint --blueprint integrations/wordpress/tests/install-blueprint.json`
  with `releases/wordpress` mounted as `/release` and
  `integrations/wordpress/tests` mounted as `/tests`. The test deliberately checks
  that a nested handoff ZIP fails while the exact 1.1.0 plugin ZIP installs.
- Windows wrapper: `powershell -File scripts/test-wordpress-presence.ps1`
  (optional `-Php 7.4 -WordPress 6.2` for the minimum advertised versions).

The office handoff is `releases/wordpress/START-HERE.txt` plus `INSTALLATION.md`.
Upload only `jellybean-presence-1.1.0.zip`, NOT an outer handoff archive. The ZIP contains only
reviewed PHP/JS/readme files; per-site keys must always be delivered separately.

## Validation on 2026-10-17

- Real WordPress installer, activation, settings, anonymous REST permissions,
  HMAC transport, admin nonce-protected diagnostics, deduplication and uninstall
  passed on WP 6.2/PHP 7.4 and latest WP/PHP 8.4 (also WP 6.8/PHP 8.3 installer/REST).
- Nested outer ZIP failure reproduced as `incompatible_archive_no_plugins`.
- Four transactional SQL suites passed locally and on production through MCP.
- Worker v26 and arrival endpoint v2 deployed. Signed diagnostics returned
  `connected`; forged, stale and wrong-origin requests returned 401. No arrival
  rows were created by diagnostic checks. The two 404 workspaces remain paused.
- These are backend/local WordPress checks, NOT a real office-site installation
  or navigation-to-visible-greeting latency measurement. Fast Fix still needs
  administrator installation and a controlled fresh visit before wider rollout.

## Validation on 2026-10-17 (plugin v1.2.0 + compact greetings)

- Greeting copy shortened and made name-free for all 13 workspaces via migration
  `20261017053142_crisp_compact_greeting_messages` (applied on production through
  MCP). New 120-char and `{{name}}`-rejection CHECK constraints verified by
  `supabase/tests/crisp-compact-greetings.sql` (local PGlite + production).
  Pending greeting jobs adopted the new copy; delivered history untouched.
- Save-side enforcement: `src/lib/crisp-greeting-policy.ts` (vitest covered) and
  settings UI counters/placeholders updated. tsc, ESLint, prettier, and all 192
  vitest tests pass.
- Plugin v1.2.0 adds `assets/chat-safety.css`, which disables only the legacy
  `isolated-govee-popup-frame` promotion iframe found on goveeinstallation.com and
  goveeinstallers.net (transparent fixed iframe, z-index 2147483646, overlapping
  Crisp's preview/close area). Live-browser probes (Playwright + Edge, desktop and
  390x844 mobile emulation) confirmed the overlap; Crisp itself stayed untouched.
- Regression `scripts/test-crisp-chat-safety.mjs` (`bun run test:crisp-chat-safety`)
  proves the native close control remains clickable on mouse and touch, and the
  launcher/unrelated iframes are unaffected, including after the legacy snippet
  redisplay attempt.
- Real WordPress install/activation/REST/uninstall passed for v1.2.0 on
  WP 6.2/PHP 7.4 and latest WP/PHP 8.4. PHP lint and 16 offline relay tests pass.
- Release: `releases/wordpress/jellybean-presence-1.2.0.zip`
  SHA256 `CC8D56594BF8B5A6C3EC00D2CA8F0403CAF0AFEF7F4D136A6020B4B0CF361DBF`;
  contents scanned: no credentials. Handoff copied to Downloads
  `JellyBean-WordPress-1.2.0` with `START-HERE.txt`, `INSTALLATION.md`,
  `CLOSE-BUTTON-FIX.txt`.
