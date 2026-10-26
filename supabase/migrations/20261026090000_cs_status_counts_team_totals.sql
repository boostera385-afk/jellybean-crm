-- CS agents see the team's status counts, the same as admins and CS admins.
--
-- Until now a CS agent's chips counted only the leads they can open (assigned
-- to them, unassigned, or created by them). The team wants every CS user to
-- see the whole pipeline's numbers. Only the counts change: which lead rows a
-- CS agent can read is still decided by qualified_leads' own RLS, untouched.
--
-- Both functions keep their role check, so nobody outside admin, sub_admin,
-- cs and cs_admin can read even the counts. Bodies are otherwise as in
-- 20260829120000 and 20261022110000; signatures are unchanged, so the client
-- and PostgREST keep calling them exactly as before.

CREATE OR REPLACE FUNCTION public.cs_leads_status_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  requester_id uuid := (SELECT auth.uid());
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
    GROUP BY q.cs_status
  ) AS counts;

  RETURN COALESCE(
    result,
    jsonb_build_object('all', 0, 'statuses', '{}'::jsonb)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.cs_leads_status_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cs_leads_status_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_leads_status_counts() TO service_role;

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
    WHERE (p_date_from IS NULL OR q.assigned_at >= p_date_from)
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

-- PostgREST resolves RPC calls from a cached view of the schema, and a function
-- it has not reloaded is reported as missing. Applying a migration by hand does
-- not always trip the DDL watch, so ask for the reload rather than hope for it.

NOTIFY pgrst, 'reload schema';
