-- CX Interested leads: let the status AI re-read the chat at most once a day.
--
-- Every Quo message event (the customer's or ours) marks a lead for a recheck,
-- and the worker re-read it as soon as 15 minutes had passed since its last
-- check. An interested customer we chat with daily was therefore re-read, with
-- an OpenAI call on the whole chat, after almost every exchange (leads chatting
-- for 3+ days averaged ~11 reads over 14 days).
--
-- Now a lead whose status is cx_interested waits 24 hours after its last check.
-- Its recheck request stays queued, so it is still read once that day is up;
-- every other status keeps the 15-minute gap. A person can still refresh a
-- lead at any time from Reports (enqueue_quo_ai_batch is unchanged).
--
-- Same function as 20261109121157_need_review_catches_delivered.sql except the
-- cooldown line.

CREATE OR REPLACE FUNCTION public.enqueue_quo_ai_due(p_inbox_ids text[], p_limit integer DEFAULT 5, p_policy_version text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  picked record;
  run uuid;
  remaining integer;
  queued integer := 0;
  webhooks_live boolean;
  lead_inboxes text[];
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  IF p_inbox_ids IS NULL OR cardinality(p_inbox_ids) NOT BETWEEN 1 AND 100
    OR EXISTS (
      SELECT 1 FROM unnest(p_inbox_ids) id
      WHERE id IS NULL OR id !~ '^PN[a-zA-Z0-9_-]+$'
    ) THEN
    RAISE EXCEPTION 'Invalid inbox scope';
  END IF;
  PERFORM public.expire_quo_ai_jobs();
  remaining := greatest(coalesce(p_limit, 5), 1);
  webhooks_live := EXISTS (
    SELECT 1 FROM private.quo_webhook_deliveries
    WHERE received_at > now() - interval '24 hours'
  );

  FOR picked IN
    WITH candidate AS (
      SELECT q.id, q.cs_status, q.number_name, public.lead_ai_source_key(q) AS source_key,
        CASE
          WHEN rq.lead_id IS NOT NULL THEN 0
          WHEN a.lead_id IS NULL THEN 1
          WHEN a.analyzed_at < q.ai_status_automation_started_at THEN 2
          WHEN a.state = 'review' AND a.reason_code = 'delivery_not_confirmed'
            AND a.analyzed_at < now() - interval '10 minutes'
            AND coalesce(a.last_message_at, q.ai_status_automation_started_at)
                > now() - interval '24 hours' THEN 3
          WHEN a.source_key <> public.lead_ai_source_key(q) THEN 4
          WHEN a.reason_code = 'delivery_confirmed' AND a.last_message_at IS NOT NULL
            AND a.last_message_at < now() - interval '6 hours' THEN 5
          WHEN p_policy_version IS NOT NULL AND a.policy_version <> p_policy_version THEN 6
          WHEN NOT webhooks_live AND a.state = 'unmatched'
            AND a.analyzed_at < now() - interval '3 hours'
            AND q.created_at > now() - interval '1 day' THEN 7
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
      LEFT JOIN LATERAL (
        SELECT r.started_at FROM public.lead_ai_status_runs r
        WHERE r.lead_id = q.id ORDER BY r.started_at DESC LIMIT 1
      ) last_run ON true
      WHERE NOT public.cs_status_ai_locked(q.cs_status, q.cs_status_updated_by_ai)
        AND q.ai_status_automation_started_at IS NOT NULL
        AND q.created_at >= public.quo_ai_scope_start()
        AND (
          last_run.started_at IS NULL
          OR last_run.started_at < now() - CASE
               WHEN q.cs_status = 'cx_interested'::public.cs_status THEN interval '24 hours'
               ELSE interval '15 minutes'
             END
          OR q.ai_status_automation_started_at > last_run.started_at
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.lead_ai_status_runs r
          WHERE r.lead_id = q.id AND r.outcome = 'running'
        )
    )
    SELECT * FROM candidate
    WHERE priority IS NOT NULL
    ORDER BY priority, sort_key, id
    LIMIT remaining
  LOOP
    lead_inboxes := public.quo_inboxes_for_lead(picked.number_name, p_inbox_ids);
    INSERT INTO public.lead_ai_status_runs(
      lead_id,actor_id,source_key,manual_status,requested_via,work_total
    ) VALUES (
      picked.id,NULL,picked.source_key,picked.cs_status,'management',cardinality(lead_inboxes)
    ) RETURNING id INTO run;
    INSERT INTO private.quo_ai_sync_jobs(run_id,inbox_ids) VALUES(run,lead_inboxes);
    DELETE FROM private.lead_ai_recheck_queue WHERE lead_id = picked.id;
    queued := queued+1;
  END LOOP;
  RETURN queued;
END
$function$;
