-- Read each lead's history from its own inbox, not from all of them.
--
-- Every lead names the Quo inbox it is texted from: number_name, picked on the
-- lead card from a fixed list whose entries are the inbox names ("Houston
-- Handyman OP1"). Until now each lead was read across every inbox -- 39 of
-- them, so up to 117 paged requests per lead for a customer with three
-- numbers -- which held the sweep to about 15 leads an hour. Reading the one
-- named inbox is roughly 39 times less work.
--
-- Names are matched ignoring case, spacing and punctuation, so "Los Angeles -
-- Handyman" still finds "Los Angeles Handyman". A lead whose number_name is
-- blank, or names no inbox, is read across every inbox exactly as before, so
-- nothing is lost by the change; it is only slower for those leads.
--
-- Trade-off: "Already received before" now looks for earlier texts in that one
-- inbox, so a customer who earlier texted a DIFFERENT inbox is not caught.
--
-- The inbox names are recorded by the quo-ai-status function each time it
-- lists the inboxes: ids and names only, never an inbox's number or users.

CREATE TABLE private.quo_inboxes (
  id text PRIMARY KEY CHECK (id ~ '^PN[a-zA-Z0-9_-]+$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.quo_inboxes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.quo_inboxes FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.quo_inboxes TO service_role;
CREATE POLICY "Only backend workers record inbox names" ON private.quo_inboxes
  TO service_role USING (true) WITH CHECK (true);

-- "Los Angeles - Handyman" and "los angeles handyman" are one name.
CREATE FUNCTION public.quo_name_key(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT nullif(lower(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
$$;
REVOKE ALL ON FUNCTION public.quo_name_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quo_name_key(text) TO authenticated, service_role;

-- Replaces the recorded names with Quo's current list. An empty or malformed
-- list changes nothing, so one bad response cannot wipe the mapping.
CREATE FUNCTION public.sync_quo_inboxes(p_names jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE kept integer;
BEGIN
  IF p_names IS NULL OR jsonb_typeof(p_names) <> 'object' OR p_names = '{}'::jsonb THEN
    RETURN 0;
  END IF;
  DELETE FROM private.quo_inboxes WHERE NOT (p_names ? id);
  INSERT INTO private.quo_inboxes (id, name)
  SELECT key, btrim(value) FROM jsonb_each_text(p_names)
   WHERE key ~ '^PN[a-zA-Z0-9_-]+$' AND length(btrim(value)) BETWEEN 1 AND 200
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, seen_at = now();
  GET DIAGNOSTICS kept = ROW_COUNT;
  RETURN kept;
END $$;

-- The inbox(es) a lead names, within the allowed set; all of them otherwise.
CREATE FUNCTION public.quo_inboxes_for_lead(p_number_name text, p_inbox_ids text[])
RETURNS text[] LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT array_agg(i.id ORDER BY i.id) FROM private.quo_inboxes i
      WHERE i.id = ANY (p_inbox_ids)
        AND public.quo_name_key(i.name) = public.quo_name_key(p_number_name)),
    p_inbox_ids)
$$;

REVOKE ALL ON FUNCTION public.sync_quo_inboxes(jsonb),
  public.quo_inboxes_for_lead(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_quo_inboxes(jsonb),
  public.quo_inboxes_for_lead(text, text[]) TO service_role;

-- ── Both enqueue paths now hand each job its lead's own inbox ───────────────
-- As 20261023090000 apart from lead_inboxes.

CREATE OR REPLACE FUNCTION public.enqueue_quo_ai_batch(p_actor_id uuid, p_inbox_ids text[],
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_lead_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run uuid; remaining integer; queued integer := 0; lead_inboxes text[];
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  IF p_actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_id=p_actor_id AND role::text IN ('admin','sub_admin','cs_admin')) THEN
    RAISE EXCEPTION 'AI reporting access required' USING ERRCODE='42501';
  END IF;
  IF p_inbox_ids IS NULL OR cardinality(p_inbox_ids) NOT BETWEEN 1 AND 100
    OR EXISTS (SELECT 1 FROM unnest(p_inbox_ids) id WHERE id IS NULL OR id !~ '^PN[a-zA-Z0-9_-]+$') THEN
    RAISE EXCEPTION 'Invalid inbox scope';
  END IF;
  PERFORM public.expire_quo_ai_jobs();
  SELECT least(5,
    5-count(*) FILTER (WHERE started_at>now()-interval '1 minute'),500-count(*))::integer
    INTO remaining FROM public.lead_ai_status_runs WHERE started_at>now()-interval '1 day';
  IF remaining<=0 THEN RETURN 0; END IF;
  FOR picked IN
    SELECT q.*, public.lead_ai_source_key(q) AS source_key FROM public.qualified_leads q
    LEFT JOIN LATERAL (SELECT r.started_at FROM public.lead_ai_status_runs r
      WHERE r.lead_id=q.id ORDER BY started_at DESC LIMIT 1) last_run ON true
    WHERE q.cs_status <> 'need_follow_up'
      AND q.created_at >= public.quo_ai_scope_start()
      AND (p_from IS NULL OR q.assigned_at>=p_from) AND (p_to IS NULL OR q.assigned_at<p_to)
      AND (p_lead_id IS NULL OR q.id=p_lead_id)
      AND (last_run.started_at IS NULL OR last_run.started_at<now()-interval '15 minutes')
      AND NOT EXISTS (SELECT 1 FROM public.lead_ai_status_runs r WHERE r.lead_id=q.id AND r.outcome='running')
    ORDER BY last_run.started_at ASC NULLS FIRST, (q.cs_status<>'new') DESC, q.assigned_at DESC, q.id
    LIMIT remaining
  LOOP
    lead_inboxes := public.quo_inboxes_for_lead(picked.number_name, p_inbox_ids);
    INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,manual_status,requested_via,work_total)
      VALUES(picked.id,p_actor_id,picked.source_key,picked.cs_status,
        CASE WHEN p_actor_id IS NULL THEN 'management' ELSE 'user' END,cardinality(lead_inboxes))
      RETURNING id INTO run;
    INSERT INTO private.quo_ai_sync_jobs(run_id,inbox_ids) VALUES(run,lead_inboxes);
    queued := queued+1;
  END LOOP;
  RETURN queued;
END $$;

CREATE OR REPLACE FUNCTION public.enqueue_quo_ai_due(p_inbox_ids text[], p_limit integer DEFAULT 5,
  p_policy_version text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run uuid; remaining integer; queued integer := 0; webhooks_live boolean;
  lead_inboxes text[];
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  IF p_inbox_ids IS NULL OR cardinality(p_inbox_ids) NOT BETWEEN 1 AND 100
    OR EXISTS (SELECT 1 FROM unnest(p_inbox_ids) id WHERE id IS NULL OR id !~ '^PN[a-zA-Z0-9_-]+$') THEN
    RAISE EXCEPTION 'Invalid inbox scope';
  END IF;
  PERFORM public.expire_quo_ai_jobs();
  SELECT least(greatest(coalesce(p_limit,5),1), 5,
    5 - count(*) FILTER (WHERE started_at > now() - interval '1 minute'),
    400 - count(*))::integer
    INTO remaining FROM public.lead_ai_status_runs WHERE started_at > now() - interval '1 day';
  IF remaining <= 0 THEN RETURN 0; END IF;
  webhooks_live := EXISTS (SELECT 1 FROM private.quo_webhook_deliveries
                           WHERE received_at > now() - interval '24 hours');
  FOR picked IN
    WITH candidate AS (
      SELECT q.id, q.cs_status, q.number_name, public.lead_ai_source_key(q) AS source_key,
        CASE
          WHEN rq.lead_id IS NOT NULL THEN 0
          WHEN a.lead_id IS NULL THEN 1
          WHEN a.state = 'review' AND a.reason_code = 'delivery_not_confirmed'
            AND a.analyzed_at < now() - interval '10 minutes' THEN 2
          WHEN a.source_key <> public.lead_ai_source_key(q) THEN 3
          WHEN a.reason_code = 'delivery_confirmed' AND a.last_message_at IS NOT NULL
            AND a.last_message_at < now() - interval '6 hours' THEN 4
          -- Decided under earlier rules: read it again under these.
          WHEN p_policy_version IS NOT NULL AND a.policy_version <> p_policy_version THEN 5
          -- Nothing sent yet. The webhook's delivery event normally brings the
          -- lead back the moment we text it; only when webhooks have gone quiet
          -- is it checked again, at most every 3 hours and only while new.
          WHEN NOT webhooks_live AND a.state = 'unmatched'
            AND a.analyzed_at < now() - interval '3 hours'
            AND q.created_at > now() - interval '1 day' THEN 6
          ELSE NULL
        END AS priority,
        CASE
          WHEN rq.lead_id IS NOT NULL THEN extract(epoch FROM rq.requested_at)
          WHEN a.lead_id IS NULL THEN -extract(epoch FROM q.assigned_at)
          ELSE extract(epoch FROM a.analyzed_at)
        END AS sort_key
      FROM public.qualified_leads q
      LEFT JOIN public.lead_ai_status a ON a.lead_id = q.id
      LEFT JOIN private.lead_ai_recheck_queue rq ON rq.lead_id = q.id
      LEFT JOIN LATERAL (SELECT r.started_at FROM public.lead_ai_status_runs r
        WHERE r.lead_id = q.id ORDER BY r.started_at DESC LIMIT 1) last_run ON true
      WHERE q.cs_status <> 'need_follow_up'
        AND q.created_at >= public.quo_ai_scope_start()
        AND (last_run.started_at IS NULL OR last_run.started_at < now() - interval '15 minutes')
        AND NOT EXISTS (SELECT 1 FROM public.lead_ai_status_runs r
          WHERE r.lead_id = q.id AND r.outcome = 'running')
    )
    SELECT * FROM candidate WHERE priority IS NOT NULL
    ORDER BY priority, sort_key, id
    LIMIT remaining
  LOOP
    lead_inboxes := public.quo_inboxes_for_lead(picked.number_name, p_inbox_ids);
    INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,manual_status,requested_via,work_total)
      VALUES(picked.id,NULL,picked.source_key,picked.cs_status,'management',cardinality(lead_inboxes))
      RETURNING id INTO run;
    INSERT INTO private.quo_ai_sync_jobs(run_id,inbox_ids) VALUES(run,lead_inboxes);
    DELETE FROM private.lead_ai_recheck_queue WHERE lead_id = picked.id;
    queued := queued+1;
  END LOOP;
  RETURN queued;
END $$;

REVOKE ALL ON FUNCTION public.enqueue_quo_ai_due(text[],integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_quo_ai_due(text[],integer,text) TO service_role;

NOTIFY pgrst, 'reload schema';
