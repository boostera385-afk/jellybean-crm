-- AI tag suggestions are management-only data: restrict lead_ai_status reads
-- to reporting administrators, matching the runs table policy. CS agents keep
-- seeing the manual pipeline status only. Aggregate reports stay intact because
-- the reports page is itself gated to admin/sub_admin.
DROP POLICY IF EXISTS "AI results follow lead access" ON public.lead_ai_status;
CREATE POLICY "AI suggestions for reporting administrators"
  ON public.lead_ai_status
  FOR SELECT
  TO authenticated
  USING (
    current_user_has_role_text('admin')
    OR current_user_has_role_text('sub_admin')
    OR current_user_has_role_text('cs_admin')
  );
