=== JellyBean Visitor Presence ===
Requires at least: 6.2
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPL-2.0-or-later

Uses the existing Crisp widget to send signed, rate-limited arrival hints to your
JellyBean CRM. Does not add a second chat widget, analytics cookies, names, emails
or page URLs. An identifier and random request ID are sent through WordPress to
the configured JellyBean Supabase project. Session IDs are pruned after seven days
by a daily cleanup (up to one additional day). Browser sessionStorage stores a
two-minute suppression timestamp. Respect your existing Crisp consent controls:
no signal is sent until the Crisp SDK has loaded a session.

Install via Plugins > Add New > Upload Plugin. Then Settings > JellyBean Presence.
Obtain the correct Crisp Website ID and dedicated per-site signing key from CRM
operations using a secure channel. HTTPS is required. Backend enrollment must
match the site's exact origin, including www if used. Leave existing Crisp chat
active. Save settings, then click Test backend connection. This authenticated
diagnostic does not create a visitor or send any greeting. See the accompanying
office handoff guide before enabling. Upload the plugin ZIP itself, not an outer
handoff ZIP containing another ZIP.

This plugin makes outbound HTTPS POST requests to:
https://fjscqsatzsmfivpczaud.supabase.co/functions/v1/crisp-site-arrival

The browser only contacts its own WordPress server. Site keys never appear in
JavaScript or the WordPress REST settings API. This connection is intended for
this JellyBean deployment, not arbitrary third-party backends.

No guarantee of sub-five-second greetings: widget consent/load, hosting, Crisp
identity visibility, quotas and network latency still apply. Polling remains the
recovery layer. Deactivate the relay to roll back without affecting chat.
