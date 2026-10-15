-- Read-only live-visitor latency diagnostics. Safe to run on production.
-- Run with psql (NOT -v ON_ERROR_STOP=1) so a section that your role cannot
-- read does not abort the rest. Each section names the delay it would explain.

-- 1. Is the 5s worker actually scheduled? 20261013140000 skips cron.schedule
--    entirely (RAISE NOTICE only) when pg_cron or pg_net was unavailable, so a
--    missing row here means NOTHING drives reconciliation or greetings.
--    Expect one active row with a '5 seconds' schedule.
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'crisp-auto-greet';

-- 2. Are those invocations succeeding? Repeated 'failed' means the worker is
--    scheduled but never runs to completion.
SELECT d.status, count(*) AS runs, max(d.end_time) AS last_run
FROM cron.job_run_details d JOIN cron.job j USING (jobid)
WHERE j.jobname = 'crisp-auto-greet' AND d.start_time > now() - interval '1 hour'
GROUP BY d.status ORDER BY runs DESC;

-- 3. Is pg_net delivering the POST? A 2xx is the edge function accepting the
--    wake-up; non-2xx or an empty result means the HTTP hop is the bottleneck.
SELECT status_code, count(*) AS responses, max(created) AS last_response
FROM net._http_response WHERE created > now() - interval '1 hour'
GROUP BY status_code ORDER BY responses DESC;

-- 4. Per-workspace pipeline health. since_success well above
--    visitor_sync_interval_seconds, a non-null visitor_sync_error, or a future
--    crisp_cooldown_until each directly explain stale counts. A cooldown is set
--    by crispFetch on 429/420 and (background) 401/403/404, and reconcile() is
--    skipped outright while it holds.
--    to_jsonb() keeps this working before 20261015120000 adds the column.
SELECT crisp_website_id, enabled, greeting_worker_enabled,
       now() - visitor_synced_at           AS since_claim,
       now() - visitor_sync_succeeded_at   AS since_success,
       to_jsonb(w) ->> 'visitor_sync_interval_seconds' AS sync_interval_s,
       visitor_sync_error, crisp_cooldown_until,
       live_visitor_count, active_visitor_count, visitors_limited
FROM public.crisp_workspaces w ORDER BY crisp_website_id;

-- 5. Crisp API budget. This is the hard ceiling on how fast reconciliation can
--    poll: crispFetch reserves one unit per call. If used_24h is near
--    background_budget, the reconcile interval CANNOT be lowered without
--    raising crisp_request_limit first - doing so would stall reconciliation.
SELECT w.crisp_website_id, w.crisp_request_limit, w.crisp_interactive_reserve,
       w.crisp_request_limit - w.crisp_interactive_reserve AS background_budget,
       coalesce(sum(u.requests), 0) AS used_24h,
       round(100.0 * coalesce(sum(u.requests), 0)
             / nullif(w.crisp_request_limit - w.crisp_interactive_reserve, 0), 1) AS pct_of_budget
FROM public.crisp_workspaces w
LEFT JOIN public.crisp_api_usage u
  ON u.crisp_website_id = w.crisp_website_id
 AND u.bucket_at >= date_trunc('hour', now() - interval '24 hours')
GROUP BY w.crisp_website_id, w.crisp_request_limit, w.crisp_interactive_reserve
ORDER BY pct_of_budget DESC NULLS LAST;

-- 6. Which Crisp events actually arrive. This is the empirical answer to "are we
--    even told about presence?": look for session:removed, any availability
--    event, and website:* (website-level events carry no session_id, so
--    crisp_apply_event drops them and only REST can act on them). A high
--    pending/max_attempts means events are stuck, not missing.
SELECT event_type, count(*) AS events,
       count(*) FILTER (WHERE NOT processed) AS pending,
       max(attempts) AS max_attempts, max(received_at) AS last_seen
FROM public.crisp_webhook_events
WHERE received_at > now() - interval '24 hours'
GROUP BY event_type ORDER BY events DESC;

-- 7. Receipt -> apply latency. This is the webhook half of the user-visible
--    delay. p95 of more than a few seconds means event processing, not Crisp,
--    is the lag.
SELECT count(*) AS applied,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY processed_at - received_at)  AS p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY processed_at - received_at) AS p95,
       max(processed_at - received_at) AS worst
FROM public.crisp_webhook_events
WHERE processed AND processed_at > now() - interval '24 hours';

-- 8. Presence freshness. stale_online_rows counts visitors still flagged online
--    whose last observation is old - i.e. silent departures that no
--    session:removed ever covered and only the REST sweep can clear. A number
--    that stays high means the reconcile sweep is not completing (see 4 and 5).
SELECT count(*) FILTER (WHERE is_online) AS online_rows,
       now() - max(presence_observed_at) AS newest_observation,
       count(*) FILTER (WHERE is_online
         AND coalesce(presence_observed_at, '-infinity') < now() - interval '2 minutes'
       ) AS stale_online_rows
FROM public.crisp_visitors;

-- 9. Realtime wiring. in_realtime must be true and replica_identity must be 'f'
--    (FULL) for the UI to get UPDATE broadcasts; 'd' (default) is the
--    20261015120000 fix not yet applied, and is why an offline flip or a counter
--    change would fall back to polling.
SELECT c.relname AS table_name, c.relreplident AS replica_identity,
       EXISTS (SELECT 1 FROM pg_publication_tables pt
               WHERE pt.pubname = 'supabase_realtime'
                 AND pt.schemaname = 'public' AND pt.tablename = c.relname) AS in_realtime
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('crisp_visitors', 'crisp_workspaces', 'crisp_conversations', 'crisp_messages')
ORDER BY c.relname;
