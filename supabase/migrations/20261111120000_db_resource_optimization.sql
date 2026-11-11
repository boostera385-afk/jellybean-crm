-- Database resource optimization (Micro instance was swapping: 2.15 GB committed
-- on ~1 GB RAM, disk at 70%).
--
-- 1. Bound pg_cron's run log. crisp-auto-greet runs every 5s (unchanged here)
--    and nothing ever purged cron.job_run_details: 555k rows / 707 MB since Aug.
-- 2. Drop byte-identical duplicate indexes. Every one of these has an exact twin
--    that stays, so every query plan that used either keeps working. The raw
--    lead search ORs ilike across seven columns, so one trigram index per column
--    must remain for the BitmapOr plan; we keep the smaller copy of each.
-- 3. Covering index so CS list/count queries (exact counts under RLS) can be
--    answered from a few MB of index instead of the 113 MB qualified_leads heap.
-- 4. Evaluate auth.uid() once per statement in user_feature_access RLS.
-- 5. Stop streaming WAL for tables no client subscribes to via Realtime.
--
-- VACUUM FULL of net._http_response / cron.job_run_details cannot run inside a
-- migration transaction; it was run separately after this migration.

-- 1. pg_cron run log retention ------------------------------------------------
DELETE FROM cron.job_run_details WHERE end_time < now() - interval '2 days';

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-run-log-cleanup';
SELECT cron.schedule(
  'cron-run-log-cleanup',
  '7 * * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '2 days'$$
);

-- 2. Duplicate indexes ------------------------------------------------------
-- raw_lead_cache: keep idx_rlc_*_trgm, drop the idx_rlc_trgm_* twins (~460 MB).
DROP INDEX IF EXISTS public.idx_rlc_trgm_post_text;
DROP INDEX IF EXISTS public.idx_rlc_trgm_lead_link;
DROP INDEX IF EXISTS public.idx_rlc_trgm_account_name;
DROP INDEX IF EXISTS public.idx_rlc_trgm_sub_area;
DROP INDEX IF EXISTS public.idx_rlc_trgm_incog_account;
DROP INDEX IF EXISTS public.idx_rlc_trgm_account_area;
DROP INDEX IF EXISTS public.idx_rlc_trgm_phone;

-- qualified_leads: keep idx_ql_*_trgm, drop the idx_qleads_trgm_* twins.
DROP INDEX IF EXISTS public.idx_qleads_trgm_customer_name;
DROP INDEX IF EXISTS public.idx_qleads_trgm_customer_number;
DROP INDEX IF EXISTS public.idx_qleads_trgm_customer_number_2;
DROP INDEX IF EXISTS public.idx_qleads_trgm_main_area;
DROP INDEX IF EXISTS public.idx_qleads_trgm_number_name;
DROP INDEX IF EXISTS public.idx_qleads_trgm_sub_area;

-- 3. Covering index for RLS-filtered qualified_leads lists and counts --------
CREATE INDEX IF NOT EXISTS idx_qualified_leads_status_rls_cover
  ON public.qualified_leads (cs_status)
  INCLUDE (id, assigned_to, created_by, submitted_by_role);

-- 4. RLS initplan ------------------------------------------------------------
ALTER POLICY "user_feature_access: user reads own" ON public.user_feature_access
  USING (user_id = (SELECT auth.uid()));

-- 5. Realtime publication ----------------------------------------------------
-- No client subscribes to these (see postgres_changes usages in src/), but
-- every write to them was still decoded by the Realtime WAL poller.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'profiles', 'app_settings', 'raw_leads'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
