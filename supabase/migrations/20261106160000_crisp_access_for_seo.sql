-- SEO users answer website chats in Crisp, with the same access as CS users:
-- every Crisp table policy that lets admin, cs_admin and cs in now lets seo in
-- too. On notes, seo (like cs) edits and deletes only its own; admin and
-- cs_admin still manage all notes. Nothing else changes.

DROP POLICY IF EXISTS "Crisp conversations access for cs roles" ON public.crisp_conversations;
CREATE POLICY "Crisp conversations access for cs roles" ON public.crisp_conversations
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_has_role_text('admin')) OR (SELECT public.current_user_has_role_text('cs_admin'))
      OR (SELECT public.current_user_has_role_text('cs')) OR (SELECT public.current_user_has_role_text('seo')))
  WITH CHECK ((SELECT public.current_user_has_role_text('admin')) OR (SELECT public.current_user_has_role_text('cs_admin'))
      OR (SELECT public.current_user_has_role_text('cs')) OR (SELECT public.current_user_has_role_text('seo')));

DROP POLICY IF EXISTS "Crisp messages access for cs roles" ON public.crisp_messages;
CREATE POLICY "Crisp messages access for cs roles" ON public.crisp_messages
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_has_role_text('admin')) OR (SELECT public.current_user_has_role_text('cs_admin'))
      OR (SELECT public.current_user_has_role_text('cs')) OR (SELECT public.current_user_has_role_text('seo')))
  WITH CHECK ((SELECT public.current_user_has_role_text('admin')) OR (SELECT public.current_user_has_role_text('cs_admin'))
      OR (SELECT public.current_user_has_role_text('cs')) OR (SELECT public.current_user_has_role_text('seo')));

DROP POLICY IF EXISTS "Crisp daily visitors select for cs roles" ON public.crisp_visitor_daily_visits;
CREATE POLICY "Crisp daily visitors select for cs roles" ON public.crisp_visitor_daily_visits
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_has_role_text('admin')) OR (SELECT public.current_user_has_role_text('cs_admin'))
      OR (SELECT public.current_user_has_role_text('cs')) OR (SELECT public.current_user_has_role_text('seo')));

DROP POLICY IF EXISTS "Crisp visitors select for cs roles" ON public.crisp_visitors;
CREATE POLICY "Crisp visitors select for cs roles" ON public.crisp_visitors
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_has_role_text('admin')) OR (SELECT public.current_user_has_role_text('cs_admin'))
      OR (SELECT public.current_user_has_role_text('cs')) OR (SELECT public.current_user_has_role_text('seo')));

DROP POLICY IF EXISTS "Crisp workspaces select access for cs roles" ON public.crisp_workspaces;
CREATE POLICY "Crisp workspaces select access for cs roles" ON public.crisp_workspaces
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_has_role_text('admin')) OR (SELECT public.current_user_has_role_text('cs_admin'))
      OR (SELECT public.current_user_has_role_text('cs')) OR (SELECT public.current_user_has_role_text('seo')));

DROP POLICY IF EXISTS "Crisp webhook events read for cs roles" ON public.crisp_webhook_events;
CREATE POLICY "Crisp webhook events read for cs roles" ON public.crisp_webhook_events
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin') OR public.has_role((SELECT auth.uid()), 'cs_admin')
      OR public.has_role((SELECT auth.uid()), 'cs') OR public.has_role((SELECT auth.uid()), 'seo')));

DROP POLICY IF EXISTS "Crisp conversation notes select for cs roles" ON public.crisp_conversation_notes;
CREATE POLICY "Crisp conversation notes select for cs roles" ON public.crisp_conversation_notes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid())
    AND role = ANY (ARRAY['admin','cs_admin','cs','seo']::public.app_role[])));

DROP POLICY IF EXISTS "Crisp conversation notes insert for cs roles" ON public.crisp_conversation_notes;
CREATE POLICY "Crisp conversation notes insert for cs roles" ON public.crisp_conversation_notes
  FOR INSERT TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_id = (SELECT auth.uid()) AND role = ANY (ARRAY['admin','cs_admin','cs','seo']::public.app_role[])));

DROP POLICY IF EXISTS "Crisp conversation notes update for cs roles" ON public.crisp_conversation_notes;
CREATE POLICY "Crisp conversation notes update for cs roles" ON public.crisp_conversation_notes
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid())
      AND role = ANY (ARRAY['admin','cs_admin','cs','seo']::public.app_role[]))
    AND (created_by = (SELECT auth.uid()) OR EXISTS (SELECT 1 FROM public.user_roles
      WHERE user_id = (SELECT auth.uid()) AND role = ANY (ARRAY['admin','cs_admin']::public.app_role[]))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid())
      AND role = ANY (ARRAY['admin','cs_admin','cs','seo']::public.app_role[]))
    AND (created_by = (SELECT auth.uid()) OR EXISTS (SELECT 1 FROM public.user_roles
      WHERE user_id = (SELECT auth.uid()) AND role = ANY (ARRAY['admin','cs_admin']::public.app_role[]))));

DROP POLICY IF EXISTS "Crisp conversation notes delete for cs roles" ON public.crisp_conversation_notes;
CREATE POLICY "Crisp conversation notes delete for cs roles" ON public.crisp_conversation_notes
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid())
      AND role = ANY (ARRAY['admin','cs_admin','cs','seo']::public.app_role[]))
    AND (created_by = (SELECT auth.uid()) OR EXISTS (SELECT 1 FROM public.user_roles
      WHERE user_id = (SELECT auth.uid()) AND role = ANY (ARRAY['admin','cs_admin']::public.app_role[]))));
