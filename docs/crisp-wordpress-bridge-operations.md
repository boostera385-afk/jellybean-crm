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
- Durable pending flag survives wake-up failure. Cron can claim it later. A
  consumed REST read that cannot see the new identity falls back to polling;
  never forge presence or remove quota controls to meet a latency target.
- Identity-first one-page reads are used for pending arrival hints. A visitor on
  a later page or not yet visible through Crisp's API may not be detected instantly.

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

The office handoff is `releases/wordpress/INSTALLATION.md`. The ZIP contains only
reviewed PHP/JS/readme files; per-site keys must always be delivered separately.
