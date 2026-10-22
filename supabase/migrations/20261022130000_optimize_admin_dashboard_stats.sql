-- The previous dashboard RPC scanned all of raw_lead_cache for four lifetime
-- category totals on every visit. Use the trigger-maintained counters instead;
-- keep only the date-bounded counts on the large tables.
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats(_today timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  raw_new bigint;
  raw_forwarded bigint;
  raw_not_found bigint;
  raw_wrong bigint;
  today_raw bigint;
  today_forwarded bigint;
  cs_counts jsonb;
BEGIN
  SELECT
    COALESCE(sum(total) FILTER (WHERE category_key IN ('new', 'assigned_myself')), 0),
    COALESCE(sum(total) FILTER (WHERE category_key = 'forwarded'), 0),
    COALESCE(sum(total) FILTER (WHERE category_key = 'not_found'), 0),
    COALESCE(sum(total) FILTER (WHERE category_key = 'wrong'), 0)
  INTO raw_new, raw_forwarded, raw_not_found, raw_wrong
  FROM public.raw_lead_cache_counts;

  SELECT count(*) INTO today_raw
  FROM public.raw_lead_cache
  WHERE captured_at >= _today;

  SELECT count(*) INTO today_forwarded
  FROM public.qualified_leads
  WHERE assigned_at >= _today;

  SELECT COALESCE(jsonb_object_agg(cs_status, status_count), '{}'::jsonb)
  INTO cs_counts
  FROM (
    SELECT cs_status, count(*)::bigint AS status_count
    FROM public.qualified_leads
    GROUP BY cs_status
  ) AS counts;

  RETURN jsonb_build_object(
    'rawCounts', jsonb_build_object(
      'new', raw_new,
      'forwarded', raw_forwarded,
      'notFound', raw_not_found,
      'wrong', raw_wrong
    ),
    'csCounts', cs_counts,
    'todayRaw', today_raw,
    'todayForwarded', today_forwarded
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats(timestamptz)
  TO authenticated, service_role;
