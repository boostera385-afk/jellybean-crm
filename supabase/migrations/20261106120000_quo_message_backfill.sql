-- One-off backfill of Quo conversations for leads the AI status worker read
-- before 20261106090000 started saving them. A backend-only queue: an operator
-- seeds it with the latest N leads, the quo-ai-status "backfill" action drains
-- it, and each lead's complete history goes to private.quo_messages through the
-- same store_quo_messages the live worker uses. Nothing here classifies a lead
-- or touches its status.

CREATE TABLE IF NOT EXISTS private.quo_message_backfill (
  lead_id uuid PRIMARY KEY REFERENCES public.qualified_leads(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'done', 'skipped', 'error')),
  attempts integer NOT NULL DEFAULT 0,
  message_count integer,
  reason text CHECK (reason IS NULL OR length(reason) <= 80),
  lease_until timestamptz,
  queued_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS quo_message_backfill_pending_idx
  ON private.quo_message_backfill (queued_at) WHERE state IN ('pending', 'running');

ALTER TABLE private.quo_message_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.quo_message_backfill FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE private.quo_message_backfill TO service_role;

-- Queue the latest p_limit leads (by creation) that are not queued already.
CREATE OR REPLACE FUNCTION public.seed_quo_message_backfill(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  queued integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invalid backfill size';
  END IF;
  INSERT INTO private.quo_message_backfill (lead_id)
  SELECT q.id FROM public.qualified_leads q
   WHERE q.customer_number IS NOT NULL
   ORDER BY q.created_at DESC, q.id
   LIMIT p_limit
  ON CONFLICT (lead_id) DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN queued;
END
$$;

-- Lease the next lead for two minutes. Reads the lead's own inbox when its
-- number_name maps to one, every inbox otherwise -- as the live worker does.
CREATE OR REPLACE FUNCTION public.claim_quo_message_backfill(p_inbox_ids text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  b private.quo_message_backfill;
  q public.qualified_leads;
  lead_inboxes text[];
BEGIN
  IF p_inbox_ids IS NULL OR cardinality(p_inbox_ids) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid inbox scope';
  END IF;
  SELECT * INTO b FROM private.quo_message_backfill
   WHERE state = 'pending' OR (state = 'running' AND lease_until < now())
   ORDER BY queued_at, lead_id
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO q FROM public.qualified_leads WHERE id = b.lead_id;
  lead_inboxes := public.quo_inboxes_for_lead(q.number_name, p_inbox_ids);
  UPDATE private.quo_message_backfill
     SET state = 'running', attempts = attempts + 1, lease_until = now() + interval '2 minutes'
   WHERE lead_id = b.lead_id;
  RETURN jsonb_build_object(
    'leadId', q.id,
    'attempts', b.attempts + 1,
    'inboxIds', lead_inboxes,
    'inboxMatched', EXISTS (SELECT 1 FROM private.quo_inbox_keys k
                             WHERE k.name_key = public.quo_name_key(q.number_name)
                               AND lead_inboxes = ARRAY[k.inbox_id]),
    'customerNumber', q.customer_number,
    'customerNumber2', q.customer_number_2,
    'extraNumbers', q.extra_numbers
  );
END
$$;

-- Record the outcome. 'pending' puts a lead whose read ran out of time back in
-- the queue; after three attempts it is recorded as an error instead.
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
         finished_at = CASE WHEN p_state = 'pending' AND attempts < 3 THEN NULL ELSE now() END
   WHERE lead_id = p_lead_id AND state = 'running';
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION public.seed_quo_message_backfill(integer),
  public.claim_quo_message_backfill(text[]),
  public.finish_quo_message_backfill(uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_quo_message_backfill(integer),
  public.claim_quo_message_backfill(text[]),
  public.finish_quo_message_backfill(uuid, text, integer, text)
  TO service_role;
