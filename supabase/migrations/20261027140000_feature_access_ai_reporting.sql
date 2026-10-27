-- =========================================================
-- Allow Feature-Access grants to view the Quo / AI reporting
-- ---------------------------------------------------------
-- Users granted the Analytics or Reports feature (Settings ->
-- Feature Access) may VIEW the AI-status comparison. Triggering Quo
-- refresh/sync work stays with the admin roles, enforced in the UI and
-- in the quo-ai-status edge function.
-- =========================================================

-- Helper so RLS policies can test the current user's feature grants.
CREATE OR REPLACE FUNCTION public.current_user_has_feature(_feature text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_feature_access
    WHERE user_id = auth.uid() AND feature = _feature AND enabled
  )
$$;

REVOKE EXECUTE ON FUNCTION public.current_user_has_feature(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_has_feature(text) TO authenticated;

-- lead_ai_status reads: the three reporting roles, plus anyone granted the
-- Analytics or Reports feature. report_lead_ai_status is SECURITY INVOKER, so
-- this governs whether the AI comparison counts are populated for them.
DROP POLICY IF EXISTS "AI suggestions for reporting administrators" ON public.lead_ai_status;
CREATE POLICY "AI suggestions for reporting administrators"
  ON public.lead_ai_status
  FOR SELECT
  TO authenticated
  USING (
    current_user_has_role_text('admin')
    OR current_user_has_role_text('sub_admin')
    OR current_user_has_role_text('cs_admin')
    OR current_user_has_feature('analytics')
    OR current_user_has_feature('reports')
  );
