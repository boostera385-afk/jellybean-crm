-- A lead put back in the backfill queue (out of time, temporary Quo error)
-- goes to the back, so the same call does not claim it again straight away.
CREATE OR REPLACE FUNCTION public.finish_quo_message_backfill(
  p_lead_id uuid,
  p_state text,
  p_message_count integer,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_state NOT IN ('pending', 'done', 'skipped', 'error') THEN
    RAISE EXCEPTION 'Invalid backfill state';
  END IF;
  UPDATE private.quo_message_backfill
     SET state = CASE WHEN p_state = 'pending' AND attempts >= 3 THEN 'error' ELSE p_state END,
         message_count = p_message_count,
         reason = left(p_reason, 80),
         lease_until = NULL,
         queued_at = CASE WHEN p_state = 'pending' THEN now() ELSE queued_at END,
         finished_at = CASE WHEN p_state = 'pending' AND attempts < 3 THEN NULL ELSE now() END
   WHERE lead_id = p_lead_id AND state = 'running';
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION public.finish_quo_message_backfill(uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_quo_message_backfill(uuid, text, integer, text)
  TO service_role;
