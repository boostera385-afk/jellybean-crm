-- CX quick chat for Need Review leads.
--
-- A lead lands in Need Review when the AI could not settle its status, and the
-- person reviewing it needs the customer's conversation to decide. The Quo
-- messages the AI read are kept in private.quo_messages (not exposed through
-- the API). This function hands back the latest messages of ONE lead, and only
-- to someone who may already read that lead: the check below is the
-- "qualified_leads: read" policy word for word, so who can see what does not
-- change. Read-only; nothing is sent to the customer.

CREATE OR REPLACE FUNCTION public.cs_lead_quo_chat(p_lead_id uuid, p_limit integer DEFAULT 40)
RETURNS TABLE (
  id text,
  direction text,
  body text,
  status text,
  has_media boolean,
  message_created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_lead_id IS NULL THEN
    RAISE EXCEPTION 'Lead is required';
  END IF;

  -- Same rule as the "qualified_leads: read" policy.
  IF NOT EXISTS (
    SELECT 1 FROM public.qualified_leads q
    WHERE q.id = p_lead_id
      AND (
        public.current_user_has_role_text('admin')
        OR public.current_user_has_role_text('sub_admin')
        OR public.current_user_has_role_text('cs_admin')
        OR (public.current_user_has_role_text('cs')
            AND (q.assigned_to = (SELECT auth.uid()) OR q.assigned_to IS NULL))
        OR q.created_by = (SELECT auth.uid())
        OR (public.current_user_has_role_text('fb_admin') AND q.submitted_by_role = 'facebook')
      )
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  SELECT m.id, m.direction, m.body, m.status, m.has_media, m.message_created_at
  FROM (
    SELECT * FROM private.quo_messages pm
    WHERE pm.lead_ids @> ARRAY[p_lead_id]
    ORDER BY pm.message_created_at DESC, pm.id DESC
    LIMIT least(greatest(coalesce(p_limit, 40), 1), 100)
  ) m
  ORDER BY m.message_created_at ASC, m.id ASC;
END
$$;

REVOKE ALL ON FUNCTION public.cs_lead_quo_chat(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cs_lead_quo_chat(uuid, integer) TO authenticated, service_role;
