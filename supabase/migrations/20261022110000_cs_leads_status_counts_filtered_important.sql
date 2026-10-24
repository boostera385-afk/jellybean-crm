-- Replace the stale cs_leads_status_counts_filtered() signature.
--
-- 20261022090000 first shipped this function with a p_garage_patterns text[]
-- argument, matching the garage-door toggle the pipeline had at the time. It
-- was applied. Main had meanwhile replaced that toggle with the "important"
-- filter, so merging the two rewrote the client to send p_important -- and
-- rewrote that migration file in place.
--
-- Editing an applied migration changes nothing: Supabase records migrations by
-- version and never re-runs one. The database kept the garage signature, the
-- client asked for p_important, and PostgREST -- which matches an RPC call by
-- argument NAME -- could not find the function at all. The client fell back to
-- the unfiltered counts, so the chips went on showing all-time totals next to
-- a filtered list: the exact bug the function was added to fix.
--
-- So: drop the signature that is actually out there, then create the one the
-- client calls. The DROP is a no-op on a database built from scratch, where
-- 20261022090000 now creates the p_important version directly; both paths end
-- at the same single function.
--
-- Column names cannot be parameterised, so the searched columns are fixed here
-- and must match the list in src/routes/app.cs-leads.tsx.

-- Named in full: dropping by name alone fails while two overloads exist, and
-- leaving the old one in place keeps a dead overload that nothing calls.
DROP FUNCTION IF EXISTS public.cs_leads_status_counts_filtered(
  timestamptz, timestamptz, uuid, boolean, boolean, text, text, text[]
);

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

-- PostgREST resolves RPC calls from a cached view of the schema, and a function
-- it has not reloaded is reported as missing. Applying a migration by hand does
-- not always trip the DDL watch, so ask for the reload rather than hope for it.
NOTIFY pgrst, 'reload schema';
