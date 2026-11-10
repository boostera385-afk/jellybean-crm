-- A lead in Need Review is listed there only, not also under its status tab.
--
-- A Delivered lead the AI could not settle showed up both in Need Review and
-- in Delivered (and an AI "didn't reply" one in both places too). The status
-- chips now count only leads that are not waiting for review, matching the
-- list, and the unfiltered counts use the same Need Review rule as the
-- filtered ones.

CREATE OR REPLACE FUNCTION public.cs_lead_in_review(
  p_review_required boolean,
  p_status public.cs_status,
  p_updated_by_ai boolean,
  p_human_updated_at timestamptz
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(p_review_required, false)
     AND public.cs_status_ai_may_change(p_status, p_updated_by_ai, p_human_updated_at)
$$;

CREATE OR REPLACE FUNCTION public.cs_leads_status_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  requester_id uuid := (SELECT auth.uid());
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = requester_id AND role::text IN ('admin','sub_admin','cs','cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  WITH base AS MATERIALIZED (
    SELECT q.cs_status,
           public.cs_lead_in_review(q.ai_review_required, q.cs_status,
                                    q.cs_status_updated_by_ai,
                                    q.cs_status_human_updated_at) AS in_review
    FROM public.qualified_leads q
  ), counts AS (
    SELECT cs_status,count(*)::bigint AS status_count FROM base
    WHERE NOT in_review GROUP BY cs_status
  )
  SELECT jsonb_build_object(
    'all', (SELECT count(*)::bigint FROM base),
    'needsReview', (SELECT count(*)::bigint FROM base WHERE in_review),
    'statuses', coalesce((SELECT jsonb_object_agg(cs_status::text,status_count) FROM counts),'{}'::jsonb)
  ) INTO result;
  RETURN coalesce(result,jsonb_build_object('all',0,'needsReview',0,'statuses','{}'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.cs_leads_status_counts_filtered(p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_owner uuid DEFAULT NULL::uuid, p_unassigned boolean DEFAULT false, p_not_called boolean DEFAULT false, p_important boolean DEFAULT false, p_search text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  requester_id uuid := (SELECT auth.uid());
  search_like text := CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL ELSE '%'||p_search||'%' END;
  phone_like text;
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = requester_id AND role::text IN ('admin','sub_admin','cs','cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  phone_like := coalesce(p_phone,search_like);

  WITH filtered AS MATERIALIZED (
    SELECT q.cs_status,
           public.cs_lead_in_review(q.ai_review_required, q.cs_status,
                                    q.cs_status_updated_by_ai,
                                    q.cs_status_human_updated_at) AS in_review
    FROM public.qualified_leads q
    WHERE (p_date_from IS NULL OR q.assigned_at >= p_date_from)
      AND (p_date_to IS NULL OR q.assigned_at < p_date_to)
      AND CASE
        WHEN p_unassigned THEN q.assigned_to IS NULL
        WHEN p_owner IS NOT NULL THEN q.assigned_to = p_owner
        ELSE true END
      AND (NOT p_not_called OR (q.called_at IS NULL AND q.quo_last_call_at IS NULL AND q.quo_outbound_calls = 0))
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
  ), counts AS (
    SELECT cs_status,count(*)::bigint AS status_count FROM filtered
    WHERE NOT in_review GROUP BY cs_status
  )
  SELECT jsonb_build_object(
    'all', (SELECT count(*)::bigint FROM filtered),
    'needsReview', (SELECT count(*)::bigint FROM filtered WHERE in_review),
    'statuses', coalesce((SELECT jsonb_object_agg(cs_status::text,status_count) FROM counts),'{}'::jsonb)
  ) INTO result;
  RETURN coalesce(result,jsonb_build_object('all',0,'needsReview',0,'statuses','{}'::jsonb));
END
$function$;
