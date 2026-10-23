-- Match a lead to its Quo inbox by the inbox's NUMBER, not only its name.
--
-- 20261023120000 matched a lead's number_name to the Quo inbox with the same
-- name. Quo has since renamed some inboxes - "Dallas Garage Door (HOLD
-- OUTBOUND)", "Chicago Facebook (No Outbound)" - so the lead-card name no
-- longer equals the Quo name and those leads fell back to every inbox. The
-- lead-card list now carries each inbox's number
-- (supabase/functions/_shared/quo-number-names.ts), and the quo-ai-status
-- function works out which inbox each saved name means, by that number. It
-- records the result here; this table is the only mapping.
--
-- Matching is by number only: Quo's names have drifted from the lead card's,
-- and an option with no known number is an inbox no longer in use.
--
-- "Already received before" is judged only for a lead whose number_name maps
-- to its inbox: earlier texts are looked for in THAT inbox. A lead without one
-- is still read across every inbox for its other statuses, but is never marked
-- as received before. The claim tells the worker which case a job is.
--
-- Replaces private.quo_inboxes and sync_quo_inboxes from 20261023120000.

CREATE TABLE private.quo_inbox_keys (
  -- public.quo_name_key of a saved number_name, or of a Quo inbox name.
  name_key text PRIMARY KEY CHECK (name_key ~ '^[a-z0-9]{1,200}$'),
  inbox_id text NOT NULL CHECK (inbox_id ~ '^PN[a-zA-Z0-9_-]+$'),
  seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.quo_inbox_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.quo_inbox_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.quo_inbox_keys TO service_role;
CREATE POLICY "Only backend workers record inbox keys" ON private.quo_inbox_keys
  TO service_role USING (true) WITH CHECK (true);

-- Replaces the mapping with the function's latest. An empty or malformed one
-- changes nothing, so one bad response from Quo cannot wipe it.
CREATE FUNCTION public.sync_quo_inbox_keys(p_keys jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE kept integer;
BEGIN
  IF p_keys IS NULL OR jsonb_typeof(p_keys) <> 'object' OR p_keys = '{}'::jsonb THEN
    RETURN 0;
  END IF;
  DELETE FROM private.quo_inbox_keys WHERE NOT (p_keys ? name_key);
  INSERT INTO private.quo_inbox_keys (name_key, inbox_id)
  SELECT key, value FROM jsonb_each_text(p_keys)
   WHERE key ~ '^[a-z0-9]{1,200}$' AND value ~ '^PN[a-zA-Z0-9_-]+$'
  ON CONFLICT (name_key) DO UPDATE SET inbox_id = excluded.inbox_id, seen_at = now();
  GET DIAGNOSTICS kept = ROW_COUNT;
  RETURN kept;
END $$;

-- The inbox a lead names, within the allowed set; every allowed inbox otherwise.
CREATE OR REPLACE FUNCTION public.quo_inboxes_for_lead(p_number_name text, p_inbox_ids text[])
RETURNS text[] LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT ARRAY[k.inbox_id] FROM private.quo_inbox_keys k
      WHERE k.name_key = public.quo_name_key(p_number_name)
        AND k.inbox_id = ANY (p_inbox_ids)),
    p_inbox_ids)
$$;

REVOKE ALL ON FUNCTION public.sync_quo_inbox_keys(jsonb),
  public.quo_inboxes_for_lead(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_quo_inbox_keys(jsonb),
  public.quo_inboxes_for_lead(text, text[]) TO service_role;

-- As 20261023090000 apart from 'inboxMatched'.
CREATE OR REPLACE FUNCTION public.claim_quo_ai_job() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE j private.quo_ai_sync_jobs; r public.lead_ai_status_runs; q public.qualified_leads; lease uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  PERFORM public.expire_quo_ai_jobs();
  IF EXISTS(SELECT 1 FROM private.quo_ai_sync_jobs WHERE lease_until>now()) THEN RETURN NULL; END IF;
  FOR j IN SELECT * FROM private.quo_ai_sync_jobs WHERE next_attempt_at<=now()
    ORDER BY created_at,run_id FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO r FROM public.lead_ai_status_runs WHERE id=j.run_id;
    SELECT * INTO q FROM public.qualified_leads WHERE id=r.lead_id;
    IF NOT FOUND OR q.cs_status='need_follow_up' OR r.source_key<>public.lead_ai_source_key(q)
      OR (r.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.user_roles
        WHERE user_id=r.actor_id AND role::text IN ('admin','sub_admin','cs_admin'))) THEN
      UPDATE public.lead_ai_status_runs SET outcome='stale',finished_at=now() WHERE id=j.run_id;
      DELETE FROM private.quo_ai_sync_jobs WHERE run_id=j.run_id;
      CONTINUE;
    END IF;
    lease := gen_random_uuid();
    UPDATE private.quo_ai_sync_jobs SET lease_token=lease,lease_until=now()+interval '2 minutes'
      WHERE run_id=j.run_id;
    RETURN jsonb_build_object('runId',j.run_id,'leaseToken',lease,'leadId',q.id,
      'inboxIds',j.inbox_ids,'checkpoint',j.encrypted_checkpoint,'snapshot',j.created_at,'failures',j.failures,
      'customerNumber',q.customer_number,'customerNumber2',q.customer_number_2,'extraNumbers',q.extra_numbers,
      'assignedAt',q.assigned_at,'createdAt',q.created_at,'service',q.service,
      -- True only when this job reads exactly the inbox the lead's number_name
      -- maps to. "Already received before" is judged only then.
      'inboxMatched',EXISTS(SELECT 1 FROM private.quo_inbox_keys k
        WHERE k.name_key = public.quo_name_key(q.number_name)
          AND j.inbox_ids = ARRAY[k.inbox_id]));
  END LOOP;
  RETURN NULL;
END $$;

DROP FUNCTION IF EXISTS public.sync_quo_inboxes(jsonb);
DROP TABLE IF EXISTS private.quo_inboxes;

NOTIFY pgrst, 'reload schema';
