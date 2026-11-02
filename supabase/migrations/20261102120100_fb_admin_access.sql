-- fb_admin access: see own + all FB submitters' leads, submit leads, and read
-- the "leads forwarded per user" report scoped to FB submitters + self.
--
-- An fb_admin manages the facebook-role users (create, edit, access codes), but
-- that is enforced in the user-management server functions, not here. This
-- migration only opens the lead data an fb_admin may read and the report they
-- may run. Roles are compared as text (current_user_has_role_text) so the new
-- enum value never appears as a literal.

-- ── qualified_leads: fb_admin reads every FB-submitted lead, plus its own ─────
-- Same as 20260710110412 apart from the fb_admin clause. submitted_by_role is
-- the role the lead was sent in under; 'facebook' marks an FB submitter's lead.
DROP POLICY IF EXISTS "qualified_leads: read" ON public.qualified_leads;
CREATE POLICY "qualified_leads: read"
ON public.qualified_leads FOR SELECT TO authenticated
USING (
  current_user_has_role('admin'::app_role)
  OR current_user_has_role_text('sub_admin')
  OR current_user_has_role_text('cs_admin')
  OR (current_user_has_role('cs'::app_role) AND (assigned_to = auth.uid() OR assigned_to IS NULL))
  OR (created_by = auth.uid())
  OR (current_user_has_role_text('fb_admin') AND submitted_by_role = 'facebook')
);

-- fb_admin may submit leads of its own, exactly like the FB submitters it manages.
DROP POLICY IF EXISTS "qualified_leads: insert" ON public.qualified_leads;
CREATE POLICY "qualified_leads: insert"
ON public.qualified_leads FOR INSERT TO authenticated
WITH CHECK (
  current_user_has_role('admin'::app_role)
  OR current_user_has_role_text('sub_admin')
  OR current_user_has_role_text('cs_admin')
  OR current_user_has_role_text('scraping')
  OR current_user_has_role_text('maturing')
  OR current_user_has_role_text('acc_handler')
  OR current_user_has_role_text('facebook')
  OR current_user_has_role_text('seo')
  OR current_user_has_role_text('fb_admin')
);
-- Update/delete are unchanged: the existing "created_by = auth.uid() AND
-- cs_status = 'new'" clause already lets an fb_admin edit or remove its own
-- freshly submitted leads, and it may only view (never edit) others' leads.

-- ── report_leads_forwarded_by_user: allow fb_admin, scoped to FB + self ──────
-- Same as 20260904100000 apart from the authorization: admin/sub_admin see
-- everyone; an fb_admin sees only facebook-role users and their own row, so the
-- report never leaks other teams' counts.
CREATE OR REPLACE FUNCTION public.report_leads_forwarded_by_user(
  _from timestamp with time zone DEFAULT NULL,
  _to timestamp with time zone DEFAULT NULL
)
RETURNS TABLE(
  user_id uuid,
  user_name text,
  user_email text,
  forwarded_count bigint,
  status_counts jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_privileged boolean := current_user_has_role_text('admin')
    OR current_user_has_role_text('sub_admin');
  v_fb_admin boolean := current_user_has_role_text('fb_admin');
BEGIN
  IF NOT (v_privileged OR v_fb_admin) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  WITH forwarded AS (
    SELECT
      COALESCE(q.created_by, q.assigned_by) AS f_user_id,
      COALESCE(q.cs_status::text, 'new') AS f_status,
      COUNT(*)::bigint AS f_count
    FROM public.qualified_leads q
    WHERE (_from IS NULL OR q.assigned_at >= _from)
      AND (_to IS NULL OR q.assigned_at <  _to)
    GROUP BY COALESCE(q.created_by, q.assigned_by), COALESCE(q.cs_status::text, 'new')
  ),
  aggregated AS (
    SELECT
      f.f_user_id AS uid,
      SUM(f.f_count)::bigint AS total_forwarded,
      jsonb_object_agg(f.f_status, f.f_count) AS statuses
    FROM forwarded f
    GROUP BY f.f_user_id
  )
  SELECT
    a.uid,
    COALESCE(
      NULLIF(BTRIM(p.full_name), ''),
      NULLIF(BTRIM(p.username), ''),
      NULLIF(BTRIM(au.raw_user_meta_data->>'full_name'), ''),
      NULLIF(BTRIM(au.raw_user_meta_data->>'name'), ''),
      NULLIF(BTRIM(p.email), ''),
      NULLIF(BTRIM(au.email), '')
    ) AS user_name,
    COALESCE(NULLIF(BTRIM(p.email), ''), NULLIF(BTRIM(au.email), '')) AS user_email,
    a.total_forwarded AS forwarded_count,
    COALESCE(a.statuses, '{}'::jsonb) AS status_counts
  FROM aggregated a
  LEFT JOIN LATERAL (
    SELECT p1.full_name, p1.username, p1.email
    FROM public.profiles p1
    WHERE p1.user_id = a.uid OR p1.id = a.uid
    ORDER BY CASE WHEN p1.user_id = a.uid THEN 0 ELSE 1 END
    LIMIT 1
  ) p ON TRUE
  LEFT JOIN auth.users au ON au.id = a.uid
  WHERE a.uid IS NOT NULL
    AND COALESCE(
      NULLIF(BTRIM(p.full_name), ''),
      NULLIF(BTRIM(p.username), ''),
      NULLIF(BTRIM(au.raw_user_meta_data->>'full_name'), ''),
      NULLIF(BTRIM(au.raw_user_meta_data->>'name'), ''),
      NULLIF(BTRIM(p.email), ''),
      NULLIF(BTRIM(au.email), '')
    ) IS NOT NULL
    -- fb_admin is limited to facebook-role users and its own row.
    AND (
      v_privileged
      OR a.uid = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = a.uid AND ur.role::text = 'facebook'
      )
    )
  ORDER BY a.total_forwarded DESC;
END;
$function$;

NOTIFY pgrst, 'reload schema';
