-- AI status: which leads it applies to, and the rules agreed for it.
--
--   * It applies to leads created from five days before this migration runs,
--     and every lead after: the five days to test on, then everything new.
--     Older leads are left alone, and their earlier test results are cleared
--     (every result stays in the lead_ai_status_runs audit).
--   * No reply within 6 hours of a delivered message is "CX didn't replied"
--     (was 24).
--   * A lead nothing has been sent to gets no AI status at all, so "New"
--     stays untouched. The worker now records those as unmatched rather than
--     classifying them "new", and the report counts them separately instead of
--     as needing review.
--   * A lead we had already been texting, or who texted us, before it was
--     created is "Already received before". Decided by the worker from Quo's
--     history, so the claim now hands it the lead's created_at.
--
-- Unchanged: delivered and undelivered still come straight from Quo's receipts
-- with no model; a reply is still read by the model; and a later reply still
-- re-queues the lead through the webhook, so "didn't reply" and "delivered"
-- update when the customer answers. Nothing here writes cs_status.

-- ── Where the AI status starts ──────────────────────────────────────────────
CREATE TABLE private.quo_ai_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  scope_start timestamptz NOT NULL
);
INSERT INTO private.quo_ai_settings (scope_start) VALUES (now() - interval '5 days')
  ON CONFLICT (id) DO NOTHING;
ALTER TABLE private.quo_ai_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.quo_ai_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.quo_ai_settings TO service_role;
CREATE POLICY "Only backend workers change the AI scope" ON private.quo_ai_settings
  TO service_role USING (true) WITH CHECK (true);

-- Readable by reports, which run as the signed-in user: it is one timestamp.
CREATE FUNCTION public.quo_ai_scope_start() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT scope_start FROM private.quo_ai_settings WHERE id
$$;
REVOKE ALL ON FUNCTION public.quo_ai_scope_start() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quo_ai_scope_start() TO authenticated, service_role;

-- ── The claim hands the worker the lead's creation time ─────────────────────
-- As 20261021113225 apart from 'createdAt'.
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
      'assignedAt',q.assigned_at,'createdAt',q.created_at,'service',q.service);
  END LOOP;
  RETURN NULL;
END $$;

-- ── Refresh button: in-scope leads only ─────────────────────────────────────
-- As 20261021113225 apart from the scope condition.
CREATE OR REPLACE FUNCTION public.enqueue_quo_ai_batch(p_actor_id uuid, p_inbox_ids text[],
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_lead_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run uuid; remaining integer; queued integer := 0;
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
    INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,manual_status,requested_via,work_total)
      VALUES(picked.id,p_actor_id,picked.source_key,picked.cs_status,
        CASE WHEN p_actor_id IS NULL THEN 'management' ELSE 'user' END,cardinality(p_inbox_ids))
      RETURNING id INTO run;
    INSERT INTO private.quo_ai_sync_jobs(run_id,inbox_ids) VALUES(run,p_inbox_ids);
    queued := queued+1;
  END LOOP;
  RETURN queued;
END $$;

-- ── Webhook: queue in-scope leads only ──────────────────────────────────────
-- As 20261022150000 apart from the scope condition.
CREATE OR REPLACE FUNCTION public.accept_quo_webhook_event(
  p_webhook_id text, p_event_type text, p_phone text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE normalized text; v_reason text; inserted integer; matched integer := 0;
BEGIN
  IF p_webhook_id IS NULL OR length(p_webhook_id) NOT BETWEEN 1 AND 200
    OR p_event_type IS NULL OR length(p_event_type) > 80 THEN
    RAISE EXCEPTION 'Invalid webhook event';
  END IF;
  INSERT INTO private.quo_webhook_deliveries(webhook_id, event_type)
    VALUES (p_webhook_id, p_event_type) ON CONFLICT (webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true, 'matched', 0); END IF;
  normalized := public.lead_ai_phone(p_phone);
  IF normalized IS NULL THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'unparseable_phone');
  END IF;
  v_reason := CASE p_event_type
    WHEN 'message.received' THEN 'customer_replied'
    WHEN 'message.undelivered' THEN 'delivery_failed'
    ELSE 'delivery_confirmed' END;
  WITH touched AS (
    INSERT INTO private.lead_ai_recheck_queue AS rq (lead_id, reason)
    SELECT q.id, v_reason FROM public.qualified_leads q
     WHERE q.cs_status <> 'need_follow_up'
       AND q.created_at >= public.quo_ai_scope_start()
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR EXISTS (SELECT 1 FROM unnest(q.extra_numbers) n
                    WHERE public.lead_ai_phone(n) = normalized))
    ON CONFLICT (lead_id) DO UPDATE
      SET reason = excluded.reason, requested_at = now()
    RETURNING rq.lead_id
  ) SELECT count(*)::integer INTO matched FROM touched;
  RETURN jsonb_build_object('duplicate', false, 'matched', matched, 'reason', v_reason);
END $$;

-- ── Sweep: in scope, 6 hours, and results from older rules re-read ──────────
-- The policy version arrives from the edge function as a default-NULL third
-- argument, so the previous two-argument call keeps working until that
-- function is redeployed; it just skips the re-read until then.
DROP FUNCTION public.enqueue_quo_ai_due(text[], integer);
CREATE FUNCTION public.enqueue_quo_ai_due(p_inbox_ids text[], p_limit integer DEFAULT 5,
  p_policy_version text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run uuid; remaining integer; queued integer := 0; webhooks_live boolean;
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
      SELECT q.id, q.cs_status, public.lead_ai_source_key(q) AS source_key,
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
    INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,manual_status,requested_via,work_total)
      VALUES(picked.id,NULL,picked.source_key,picked.cs_status,'management',cardinality(p_inbox_ids))
      RETURNING id INTO run;
    INSERT INTO private.quo_ai_sync_jobs(run_id,inbox_ids) VALUES(run,p_inbox_ids);
    DELETE FROM private.lead_ai_recheck_queue WHERE lead_id = picked.id;
    queued := queued+1;
  END LOOP;
  RETURN queued;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_quo_ai_due(text[],integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_quo_ai_due(text[],integer,text) TO service_role;

-- ── "Didn't reply" after 6 hours, in scope ──────────────────────────────────
-- As 20261022150000 apart from the window, the reason code and the scope.
CREATE OR REPLACE FUNCTION public.flip_quo_ai_no_reply() RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE flipped integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.quo_webhook_deliveries
                 WHERE received_at > now() - interval '24 hours') THEN
    RETURN 0;
  END IF;
  UPDATE public.lead_ai_status a
     SET ai_status = 'cx_didnt_replied'::public.cs_status,
         reason_code = 'no_reply_after_6h',
         analyzed_at = now()
    FROM public.qualified_leads q
   WHERE q.id = a.lead_id
     AND q.created_at >= public.quo_ai_scope_start()
     AND a.state = 'classified'
     AND a.ai_status = 'converted'::public.cs_status
     AND a.reason_code = 'delivery_confirmed'
     AND a.last_message_at IS NOT NULL
     AND a.last_message_at < now() - interval '6 hours'
     AND a.source_key = public.lead_ai_source_key(q)
     AND NOT EXISTS (SELECT 1 FROM private.lead_ai_recheck_queue rq WHERE rq.lead_id = a.lead_id);
  GET DIAGNOSTICS flipped = ROW_COUNT;
  RETURN flipped;
END $$;

-- ── Report: in-scope leads only, with "not contacted yet" counted apart ─────
CREATE OR REPLACE FUNCTION public.report_lead_ai_status(p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH scoped AS (
    SELECT q.cs_status, q.customer_name, a.*, a.source_key=public.lead_ai_source_key(q) AS fresh
    FROM public.qualified_leads q LEFT JOIN public.lead_ai_status a ON a.lead_id=q.id
    WHERE q.cs_status <> 'need_follow_up'
      AND q.created_at >= public.quo_ai_scope_start()
      AND (p_from IS NULL OR q.assigned_at>=p_from) AND (p_to IS NULL OR q.assigned_at<p_to)
  ), counts AS (
    SELECT ai_status::text AS status,count(*) AS n FROM scoped
    WHERE state='classified' AND fresh GROUP BY ai_status
  ) SELECT jsonb_build_object(
    'counts',coalesce((SELECT jsonb_object_agg(status,n) FROM counts),'{}'::jsonb),
    'total',count(*),
    'classified',count(*) FILTER (WHERE state='classified' AND fresh),
    'disagreements',count(*) FILTER (WHERE state='classified' AND fresh AND ai_status<>cs_status),
    -- Not contacted yet is not a problem to review; it has no AI status by design.
    'review',count(*) FILTER (WHERE state IN ('review','error') AND fresh),
    'untouched',count(*) FILTER (WHERE state='unmatched' AND fresh),
    'stale',count(*) FILTER (WHERE lead_id IS NOT NULL AND NOT fresh),
    'scopeStart',public.quo_ai_scope_start(),
    'samples',coalesce((SELECT jsonb_agg(item) FROM (
      SELECT jsonb_build_object('leadId',lead_id,'customerName',customer_name,
        'manualStatus',cs_status,'aiStatus',ai_status,'state',state,'confidence',confidence,
        'reasonCode',reason_code,'analyzedAt',analyzed_at) AS item
      FROM scoped WHERE fresh AND state<>'unmatched' AND (state<>'classified' OR ai_status<>cs_status)
      ORDER BY analyzed_at DESC,lead_id LIMIT 10
    ) examples),'[]'::jsonb),
    'lastAnalyzedAt',max(analyzed_at)
  ) FROM scoped
$$;
REVOKE ALL ON FUNCTION public.report_lead_ai_status(timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.report_lead_ai_status(timestamptz,timestamptz) TO authenticated,service_role;

-- ── Clear results for leads now outside the window ──────────────────────────
-- lead_ai_status holds only the LATEST result per lead; every result, these
-- included, stays in lead_ai_status_runs. Out-of-window work in flight is
-- fenced so it cannot write a fresh row back.
UPDATE public.lead_ai_status_runs r SET outcome = 'stale', finished_at = now()
  FROM public.qualified_leads q
 WHERE q.id = r.lead_id AND r.outcome = 'running' AND q.created_at < public.quo_ai_scope_start();
DELETE FROM private.quo_ai_sync_jobs j USING public.lead_ai_status_runs r
 WHERE r.id = j.run_id AND r.outcome <> 'running';
DELETE FROM private.lead_ai_recheck_queue rq USING public.qualified_leads q
 WHERE q.id = rq.lead_id AND q.created_at < public.quo_ai_scope_start();
DELETE FROM public.lead_ai_status a USING public.qualified_leads q
 WHERE q.id = a.lead_id AND q.created_at < public.quo_ai_scope_start();

NOTIFY pgrst, 'reload schema';
