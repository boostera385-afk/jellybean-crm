-- Filter-aware CS status counts.
--
-- The pipeline's status chips were fed by cs_leads_status_counts(), which takes
-- no arguments and always scans every visible lead. Picking "Today", an owner
-- or an area therefore narrowed the list but left the chips showing all-time
-- totals, so the numbers disagreed with the rows on screen.
--
-- This adds a filtered variant mirroring exactly the predicates the pipeline
-- list applies. The status itself is deliberately NOT a parameter: the chips
-- need every status counted within the filtered set.
--
-- cs_leads_status_counts() is left in place and is still used for the
-- unfiltered view, where it is cached and shared across the app.
--
-- Column names cannot be parameterised, so the searched columns are fixed here
-- and must match the list in src/routes/app.cs-leads.tsx.

CREATE OR REPLACE FUNCTION public.cs_leads_status_counts_filtered(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_owner uuid DEFAULT NULL,
  p_unassigned boolean DEFAULT false,
  p_not_called boolean DEFAULT false,
  p_important boolean DEFAULT false,
  p_search text DEFAULT NULL,
  p_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  requester_id uuid := (SELECT auth.uid());
  has_all_access boolean;
  search_like text := CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL
                           ELSE '%' || p_search || '%' END;
  phone_like text;
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = requester_id
      AND role::text IN ('admin', 'sub_admin', 'cs', 'cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  has_all_access := EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = requester_id
      AND role::text IN ('admin', 'sub_admin', 'cs_admin')
  );

  -- The client derives a separator-agnostic phone pattern so a digits-only
  -- term matches a formatted stored number. Fall back to the plain pattern.
  phone_like := COALESCE(p_phone, search_like);

  SELECT jsonb_build_object(
    'all', COALESCE(sum(status_count), 0),
    'statuses', COALESCE(
      jsonb_object_agg(cs_status::text, status_count),
      '{}'::jsonb
    )
  )
  INTO result
  FROM (
    SELECT q.cs_status, count(*)::bigint AS status_count
    FROM public.qualified_leads AS q
    WHERE (
            has_all_access
            OR q.assigned_to = requester_id
            OR q.assigned_to IS NULL
            OR q.created_by = requester_id
          )
      AND (p_date_from IS NULL OR q.assigned_at >= p_date_from)
      AND (p_date_to IS NULL OR q.assigned_at < p_date_to)
      AND (
            CASE
              WHEN p_unassigned THEN q.assigned_to IS NULL
              WHEN p_owner IS NOT NULL THEN q.assigned_to = p_owner
              ELSE true
            END
          )
      AND (NOT p_not_called OR q.called_at IS NULL)
      AND (NOT p_important OR q.is_important IS TRUE)
      AND (
            search_like IS NULL
            OR q.customer_name ILIKE search_like
            OR q.customer_number ILIKE phone_like
            OR q.customer_number_2 ILIKE phone_like
            OR q.number_name ILIKE search_like
            OR q.main_area ILIKE search_like
            OR q.sub_area ILIKE search_like
            OR q.pass_it_to ILIKE search_like
            OR q.requirement_1 ILIKE search_like
            OR q.requirement_2 ILIKE search_like
          )
    GROUP BY q.cs_status
  ) AS counts;

  RETURN COALESCE(
    result,
    jsonb_build_object('all', 0, 'statuses', '{}'::jsonb)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.cs_leads_status_counts_filtered(
  timestamptz, timestamptz, uuid, boolean, boolean, boolean, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.cs_leads_status_counts_filtered(
  timestamptz, timestamptz, uuid, boolean, boolean, boolean, text, text
) TO authenticated;

-- PostgREST resolves RPC calls from a cached view of the schema. A newly
-- created function it has not reloaded is reported as missing, which the
-- client cannot tell apart from any other failure, so ask for the reload
-- explicitly rather than relying on the DDL watch firing.
NOTIFY pgrst, 'reload schema';
