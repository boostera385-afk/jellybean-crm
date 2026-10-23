-- No caps on how many leads the AI checks.
--
-- Until now the AI stopped at 500 checks a day (400 for the automatic sweep),
-- and at 5 a minute, so the last 5 days' ~830 leads took two to three days.
-- Both limits go. What still applies is not a cap on volume:
--   * the 15-minute cooldown per lead, so one lead is not read twice at once;
--   * one worker at a time, pacing its Quo requests (well under Quo's limit).
-- The Refresh button now queues every eligible lead in its range, not 5.
-- The sweep runs every minute instead of every 5, still only once the queue
-- has drained.

-- As 20261023120000 apart from the caps.
CREATE OR REPLACE FUNCTION public.enqueue_quo_ai_batch(p_actor_id uuid, p_inbox_ids text[],
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_lead_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run uuid; queued integer := 0; lead_inboxes text[];
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
  -- How many to hand the worker this round; not a limit on how many a day.
  remaining := greatest(coalesce(p_limit, 5), 1);
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

-- Same command as 20261022150000; only the schedule changes.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
    AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
    PERFORM cron.schedule('quo-ai-autoqueue','* * * * *',$cron$
      SELECT net.http_post(
        url:=(SELECT regexp_replace(decrypted_secret,'/crisp-auto-greet/?$','/quo-ai-status')
          FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_url'),
        headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_key')),
        body:='{"action":"enqueue"}'::jsonb,timeout_milliseconds:=20000)
      WHERE NOT EXISTS(SELECT 1 FROM private.quo_ai_sync_jobs)
        AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_url'
          AND decrypted_secret LIKE '%/functions/v1/crisp-auto-greet')
        AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_key');
    $cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
