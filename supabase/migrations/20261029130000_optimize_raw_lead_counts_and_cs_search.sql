-- =========================================================
-- Optimize the two biggest DB costs found in pg_stat_statements
-- ---------------------------------------------------------
-- 1. raw_lead_cache category counts (tab badges) were the #1 cost: both the
--    table-returning and the _json function ran six count(*) scans over the
--    whole raw_lead_cache table on every call (~1.25s each, 100k+ calls/day).
--    A trigger-maintained counter table (raw_lead_cache_counts, backfilled at
--    creation and already trusted by report_raw_status_counts) holds exactly
--    these totals, so both functions now do O(1) primary-key lookups.
--
-- 2. The CS pipeline search ran ILIKE '%term%' across customer_name,
--    customer_number(_2), number_name, main_area and sub_area. None had a
--    trigram index, so the whole OR fell back to a sequential scan of
--    qualified_leads (searches were taking up to ~6s). Add the missing
--    trigram indexes (service/pass_it_to/requirement_* already had them).
-- =========================================================

-- Sentinel used by raw_lead_cache_counts for non-user-scoped keys.
-- (category_key IN new/forwarded/not_found/wrong/duplicate are stored under it;
--  assigned_myself is stored per assigned_to.)

-- ---- 1a. JSON variant (current client) ----
CREATE OR REPLACE FUNCTION public.raw_lead_cache_category_counts_json(
  _user_id uuid DEFAULT NULL::uuid,
  _is_admin boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'new',       COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'new'       AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    'forwarded', COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'forwarded' AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    'not_found', COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'not_found' AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    'wrong',     COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'wrong'     AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    'duplicate', COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'duplicate' AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    'assigned_myself', COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'assigned_myself' AND assigned_to = auth.uid()), 0)
  );
$function$;

-- ---- 1b. Table-returning variant (older cached clients still call this) ----
CREATE OR REPLACE FUNCTION public.raw_lead_cache_category_counts(
  _user_id uuid,
  _is_admin boolean DEFAULT false
)
RETURNS TABLE(new bigint, forwarded bigint, not_found bigint, wrong bigint, duplicate bigint, assigned_myself bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'new'       AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'forwarded' AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'not_found' AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'wrong'     AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'duplicate' AND assigned_to = '00000000-0000-0000-0000-000000000000'::uuid), 0),
    COALESCE((SELECT total FROM public.raw_lead_cache_counts WHERE category_key = 'assigned_myself' AND assigned_to = auth.uid()), 0);
$function$;

-- ---- 2. CS pipeline search: trigram indexes for the remaining ILIKE fields ----
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_ql_customer_name_trgm
  ON public.qualified_leads USING gin (customer_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ql_customer_number_trgm
  ON public.qualified_leads USING gin (customer_number extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ql_customer_number_2_trgm
  ON public.qualified_leads USING gin (customer_number_2 extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ql_number_name_trgm
  ON public.qualified_leads USING gin (number_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ql_main_area_trgm
  ON public.qualified_leads USING gin (main_area extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ql_sub_area_trgm
  ON public.qualified_leads USING gin (sub_area extensions.gin_trgm_ops);
