-- Purpose: let Marshmallow CRM find out whether a customer it just added was
-- already a JellyBean lead, and which JellyBean department brought them in.
--
-- Department rule (agreed with the owner, 2026-11-25), from the submitting role,
-- falling back to the creator's role when submitted_by_role is blank:
--   SEO = seo
--   FB  = facebook, fb_admin
--   ND  = maturing, sub_admin, acc_handler, scraping   (Nextdoor intake)
--   Other = anything else / unknown creator
-- When several JellyBean leads share the phone, the LATEST one created at or
-- before the Marshmallow lead's creation time is credited.
--
-- Read-only: no table, RLS, index or data change. Phone matching reuses the
-- existing lead_ai_phone()/lead_ai_extra_phones() expression indexes
-- (qualified_leads_ai_phone_1/_2, qualified_leads_ai_extra_normalized).
-- Only service_role may execute the lookup; Marshmallow reaches it through the
-- marshmallow-lead-lookup Edge Function, which checks a shared secret.
BEGIN;

CREATE OR REPLACE FUNCTION public.jellybean_lead_department(p_role text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_role = 'seo' THEN 'SEO'
    WHEN p_role IN ('facebook', 'fb_admin') THEN 'FB'
    WHEN p_role IN ('maturing', 'sub_admin', 'acc_handler', 'scraping') THEN 'ND'
    ELSE 'Other'
  END
$$;

-- p_requests: [{"key": text, "phones": [text, ...], "before": timestamptz}, ...]
-- Returns at most one row per key (no row = not found in JellyBean).
CREATE OR REPLACE FUNCTION public.marshmallow_department_lookup(p_requests jsonb)
RETURNS TABLE (
  request_key text,
  jellybean_lead_id uuid,
  jellybean_created_at timestamptz,
  source_role text,
  department text,
  matched_phone text
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_requests) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_requests must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_requests) > 500 THEN
    RAISE EXCEPTION 'At most 500 lookups per call' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH req AS (
    SELECT DISTINCT r->>'key' AS rkey, (r->>'before')::timestamptz AS before_at, public.lead_ai_phone(p) AS phone
    FROM jsonb_array_elements(p_requests) r
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(r->'phones') = 'array' THEN r->'phones' ELSE '[]'::jsonb END) p
    WHERE coalesce(r->>'key', '') <> '' AND r->>'before' IS NOT NULL
  ), cand AS (
    -- Three index-backed equality probes instead of one OR join.
    SELECT req.rkey, req.phone, q.id, q.created_at, q.submitted_by_role, q.created_by
      FROM req JOIN public.qualified_leads q
        ON public.lead_ai_phone(q.customer_number) = req.phone AND q.created_at <= req.before_at
     WHERE req.phone IS NOT NULL
    UNION ALL
    SELECT req.rkey, req.phone, q.id, q.created_at, q.submitted_by_role, q.created_by
      FROM req JOIN public.qualified_leads q
        ON public.lead_ai_phone(q.customer_number_2) = req.phone AND q.created_at <= req.before_at
     WHERE req.phone IS NOT NULL
    UNION ALL
    SELECT req.rkey, req.phone, q.id, q.created_at, q.submitted_by_role, q.created_by
      FROM req JOIN public.qualified_leads q
        ON public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[req.phone] AND q.created_at <= req.before_at
     WHERE req.phone IS NOT NULL
  ), best AS (
    SELECT DISTINCT ON (c.rkey) c.*
      FROM cand c
     ORDER BY c.rkey, c.created_at DESC, c.id DESC
  )
  SELECT b.rkey, b.id, b.created_at, r.role, public.jellybean_lead_department(r.role), b.phone
    FROM best b
    CROSS JOIN LATERAL (
      SELECT coalesce(
        nullif(b.submitted_by_role, ''),
        (SELECT ur.role::text FROM public.user_roles ur WHERE ur.user_id = b.created_by ORDER BY ur.role::text LIMIT 1)
      ) AS role
    ) r;
END
$$;

REVOKE ALL ON FUNCTION public.jellybean_lead_department(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jellybean_lead_department(text) TO service_role;
REVOKE ALL ON FUNCTION public.marshmallow_department_lookup(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marshmallow_department_lookup(jsonb) TO service_role;

COMMIT;

-- Rollback (read-only feature; nothing to restore):
--   DROP FUNCTION IF EXISTS public.marshmallow_department_lookup(jsonb);
--   DROP FUNCTION IF EXISTS public.jellybean_lead_department(text);
--   Undeploy marshmallow-lead-lookup and delete its MARSHMALLOW_LOOKUP_SECRET.
