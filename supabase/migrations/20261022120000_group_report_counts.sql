-- Report summaries should aggregate in Postgres instead of issuing one exact
-- count request per status or transferring every lead to the browser.
-- SECURITY INVOKER preserves the same RLS visibility as the former table reads.
CREATE FUNCTION public.report_raw_status_counts(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF p_from IS NULL AND p_to IS NULL THEN
    -- The trigger-maintained counter table avoids the historically bloated raw
    -- table entirely for the default all-time report. Both uncategorized queues
    -- belonged to the former report's category IS NULL count.
    SELECT COALESCE(jsonb_object_agg(status, total), '{}'::jsonb)
    INTO result
    FROM (
      SELECT CASE WHEN category_key IN ('new', 'assigned_myself')
                  THEN 'new' ELSE category_key END AS status,
             sum(total)::bigint AS total
      FROM public.raw_lead_cache_counts
      GROUP BY 1
    ) AS counts;
  ELSE
    SELECT COALESCE(jsonb_object_agg(status, total), '{}'::jsonb)
    INTO result
    FROM (
      SELECT COALESCE(r.category, 'new') AS status, count(*)::bigint AS total
      FROM public.raw_lead_cache AS r
      WHERE (p_from IS NULL OR r.captured_at >= p_from)
        AND (p_to IS NULL OR r.captured_at < p_to)
        AND (r.category IS NULL OR r.category IN ('forwarded', 'not_found', 'wrong', 'duplicate'))
      GROUP BY r.category
    ) AS counts;
  END IF;
  RETURN result;
END;
$function$;

CREATE FUNCTION public.report_cs_status_counts(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT COALESCE(jsonb_object_agg(status, total), '{}'::jsonb)
  FROM (
    SELECT q.cs_status::text AS status, count(*)::bigint AS total
    FROM public.qualified_leads AS q
    WHERE (p_from IS NULL OR q.assigned_at >= p_from)
      AND (p_to IS NULL OR q.assigned_at < p_to)
    GROUP BY q.cs_status
  ) AS counts;
$function$;

CREATE FUNCTION public.report_cs_department_daily(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT COALESCE(jsonb_agg(to_jsonb(counts)), '[]'::jsonb)
  FROM (
    SELECT to_char(q.assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day_key,
           q.submitted_by_role::text,
           count(*)::bigint AS lead_count
    FROM public.qualified_leads AS q
    WHERE q.assigned_at >= p_from AND q.assigned_at < p_to
    GROUP BY 1, 2
  ) AS counts;
$function$;

CREATE FUNCTION public.report_cs_service_state_counts(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT COALESCE(jsonb_agg(to_jsonb(counts)), '[]'::jsonb)
  FROM (
    SELECT q.service, q.state_code, q.main_area, q.submitted_by_role,
           count(*)::bigint AS lead_count
    FROM public.qualified_leads AS q
    WHERE q.assigned_at >= p_from AND q.assigned_at < p_to
    GROUP BY q.service, q.state_code, q.main_area, q.submitted_by_role
  ) AS counts;
$function$;

REVOKE ALL ON FUNCTION public.report_raw_status_counts(timestamptz, timestamptz),
  public.report_cs_status_counts(timestamptz, timestamptz),
  public.report_cs_department_daily(timestamptz, timestamptz),
  public.report_cs_service_state_counts(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_raw_status_counts(timestamptz, timestamptz),
  public.report_cs_status_counts(timestamptz, timestamptz),
  public.report_cs_department_daily(timestamptz, timestamptz),
  public.report_cs_service_state_counts(timestamptz, timestamptz) TO authenticated, service_role;
