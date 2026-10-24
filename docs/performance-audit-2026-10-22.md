# JellyBean performance audit — 2026-10-22

## Scope and evidence

This audit combines the repository with read-only production evidence from
Supabase. The `pg_stat_statements` snapshot was last reset on 2026-07-23, so
its cumulative totals are historical; they cannot by themselves establish
which endpoints are still called by today's deployed frontend. The 24-hour
Postgres logs identify the actual timed-out statements. No before/after
latency change has been measured yet. Do not raise `statement_timeout` to mask
the cause.

The live snapshot has about 487,000 raw leads occupying 1,594 MB, 730,000
activity logs occupying 261 MB, and 39,000 qualified leads occupying 247 MB.
Dead-row estimates are low, so today's evidence does not identify dead tuples
as the principal cause. The earlier production audit in
[database-io-optimization.md](database-io-optimization.md) is historical.

## Confirmed production timeouts

The 30 most recent timeout logs include seven `browser_profile_performance`
calls, two `get_admin_dashboard_stats` calls, six exact raw-lead counts,
three AI batch updates, three raw-lead inserts, one raw-lead update, three
activity-log/analytics queries, and five raw-lead reads. All were executed
through the PostgREST `authenticator` role. The newest was 2026-10-22
06:25 UTC.

The old dashboard function definition scans the entire raw-lead table to
compute four all-time category counts on every dashboard load. A separate
migration replaces that scan with the existing trigger-maintained six-row
counter table while retaining indexed date-bounded counts. The frontend now
caches this dashboard query for 60 seconds and avoids a refetch on focus.

The browser profile timeout was reported for the 30-day range. About 242,000
raw leads fall in the last 30 days and 139 of 166 profiles have a recent
launch. The existing function processes the date-scoped raw rows and their
JSON account fields before matching profiles. A third migration replaces the
three-candidates-per-row expansion and sort with three joins to the small
profile-key sets. A local regression test confirms identical matching priority,
tie breaks, qualified-lead totals, and output shape. The 30-day path still
needs a production-data latency measurement after rollout.
Its successful calls in `pg_stat_statements` averaged about 507 ms across 19
calls, but the seven timed-out calls are not represented by that average.

The production schema has trigram search indexes absent from the repository's
migration history. The Supabase performance advisor reports 19 unused indexes,
including several of these, but their age and workload coverage are unknown.
Do not remove them from a live write-heavy table based only on `idx_scan = 0`.
The advisor also flags six RLS policy init-plan issues and eight sets of
multiple permissive policies; none is the primary cause identified by these
timeout logs.

The highest cumulative statement (`raw_lead_cache_category_counts`, 104,000
calls and 130.6 million ms) is no longer referenced by this checkout; current
Raw Leads code calls `raw_lead_cache_category_counts_json`. Treat that large
total as historical until production request logs show otherwise.

## Confirmed load in the current code

| Path | Before this change | Change |
| --- | --- | --- |
| Reports status cards | Five raw-lead and thirteen CS exact-count HTTP requests per date range, with repeated table work | Two grouped RPCs return the same status counts; all-time raw counts use the existing trigger-maintained counter table |
| Analytics CS status chart | Thirteen concurrent exact counts for each selected range | One grouped RPC |
| Analytics department chart | Transfers individual `qualified_leads` rows to the browser; PostgREST's row cap can truncate the chart | Database groups by UTC day and department; only summary rows cross the network |
| Analytics service/state chart | Transfers individual leads for the selected range, with the same row-cap risk | Database groups by service, state and department, then returns a scalar summary |
| Activity Logs | Fetches 500 rows and exact-counts the whole log table on an unfiltered visit | Fetches 200 rows and uses the planner estimate for the unfiltered page count |
| Raw and Forwarded Leads lists | Initially fetch 500 wide lead rows per page | Initially fetch 200 rows; users can still select 500 on Raw Leads |
| Admin dashboard | Repeatedly counts the full raw-lead table for four lifetime totals | A second migration reads the trigger-maintained counters; the frontend reuses each result for 60 seconds |
| Browser Profile Performance | Expands each dated raw lead into three possible match rows, then sorts the matches | A third migration joins each dated lead directly to the small profile-key sets while preserving match priority |
| Forwarded-by-user report | A failed or empty summary could trigger a second report and thirteen exact counts for each expanded user | Uses the existing grouped report as the single source |

The four new report RPCs are `SECURITY INVOKER`, so existing row-level security
still controls which rows are included. The first migration is live in the
production database, but the updated frontend is not deployed. The dashboard
and browser-profile migrations are local files for the project owner to apply.
Local SQL tests verify grouped totals, date boundaries, row-level visibility,
dashboard output, and browser-profile matching using a PostgreSQL-compatible
runtime.

## Remaining risks to investigate with production evidence

1. Browser Profile Performance still processes up to hundreds of thousands of
   date-scoped raw leads for the 30-day range. The local rewrite removes the
   match expansion, but its seven observed timeouts require a before/after
   production-data benchmark. If it remains slow, inspect the plan and consider
   a pre-aggregated summary while preserving per-profile and top-service totals.
2. Raw-lead free-text search applies seven `ILIKE '%term%'` predicates, including
   JSON fields, over the historically largest table. Its filtered exact count
   repeats the search. Adding seven speculative indexes would increase write
   amplification on a table already known to be bloated; measure the actual
   query plan on a database branch first.
3. Activity Log free-text search also runs an exact count with four `ILIKE`
   predicates. Date filters can use the existing `created_at` index, but text
   search may still scan. Measure search frequency and plans before indexing.
4. Offset pagination on lead and log pages grows more expensive at deep pages.
   Raw leads have a keyset path; the other pages should move only after usage
   shows deep-page latency matters.
5. The historical raw-lead table bloat needs separate, scheduled maintenance.
   A table repack and possible index removals require fresh disk, I/O and plan
   measurements; neither belongs in an ordinary app deployment.

## Read-only production diagnostics

Run these in the Supabase SQL editor during a representative slow period. The
first query requires `pg_stat_statements` to be enabled and visible to the
operator. Capture the full query text and timing for any failed endpoint, plus
the date range and role that triggered it.

```sql
SELECT left(query, 500) AS query_sample, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       round(max_exec_time::numeric, 1) AS max_ms,
       shared_blks_read, temp_blks_written
FROM pg_stat_statements
WHERE calls > 0
ORDER BY total_exec_time DESC
LIMIT 30;

SELECT relname, n_live_tup, n_dead_tup,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;

SELECT pid, now() - query_start AS running_for, wait_event_type, wait_event,
       state, left(query, 500) AS query_sample
FROM pg_stat_activity
WHERE datname = current_database() AND state = 'active'
  AND pid <> pg_backend_pid()
ORDER BY query_start;
```

After applying the remaining migrations on a staging branch, compare each RPC
with the former exact counts for an unfiltered and a bounded date range. Run
`EXPLAIN (ANALYZE, BUFFERS)` only on that branch, with representative data.
Monitor request duration, DB I/O, temporary writes, and timeout counts after
deployment before deciding on indexes or table maintenance.
