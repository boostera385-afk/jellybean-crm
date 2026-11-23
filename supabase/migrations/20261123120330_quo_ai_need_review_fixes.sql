-- Need Review clean-up (status AI scheduler).
--
-- A. AI errors were never retried: 27 leads failed during one OpenAI outage
--    (Nov 18, 18:00-24:00 UTC) and sat in Need Review for days. A lead whose
--    last check ended in an error is now retried after 30 minutes, at most
--    3 times a day.
-- E. A text still "sent" (never confirmed by the carrier) is treated as
--    delivered after 24 hours by the worker. Such leads are rechecked for 48
--    hours after the last message (was 24) so that rule gets its chance.
-- Plus a one-off: every lead now in Need Review for a reason these fixes
-- address is queued for one recheck, so it picks up the new rules (number on
-- the chat, call-only fallback, "check number name", retry).
--
-- Same function as 20261123065857_quo_ai_closed_daily_and_30_day_window.sql
-- except the marked lines.

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
  -- Old leads are no longer checked automatically: drop their recheck requests.
  DELETE FROM private.lead_ai_recheck_queue rq
  USING public.qualified_leads q
  WHERE q.id = rq.lead_id AND q.created_at < now() - interval '30 days';
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
                > now() - interval '48 hours' THEN 3
          WHEN a.source_key <> public.lead_ai_source_key(q) THEN 4
          WHEN a.reason_code = 'delivery_confirmed' AND a.last_message_at IS NOT NULL
            AND a.last_message_at < now() - interval '6 hours' THEN 5
          WHEN p_policy_version IS NOT NULL AND a.policy_version <> p_policy_version THEN 6
          WHEN NOT webhooks_live AND a.state = 'unmatched'
            AND a.analyzed_at < now() - interval '3 hours'
            AND q.created_at > now() - interval '1 day' THEN 7
          WHEN a.state = 'error' AND a.analyzed_at < now() - interval '30 minutes'
            AND (SELECT count(*) FROM public.lead_ai_status_runs e
                 WHERE e.lead_id = q.id AND e.outcome = 'error'
                   AND e.started_at > now() - interval '1 day') < 3 THEN 8
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
        AND q.created_at >= now() - interval '30 days'
        AND (
          last_run.started_at IS NULL
          OR last_run.started_at < now() - CASE
               WHEN q.cs_status::text IN (
                 'cx_interested',
                 'cx_not_interested', 'not_interested', 'already_got_someone', 'already_done',
                 'wrong_number', 'wrong_person', 'wrong_lead', 'wrong_service', 'small_service',
                 'service_provider_himself', 'out_of_base', 'already_received_before',
                 'closed_won', 'closed_lost'
               ) THEN interval '24 hours'
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

-- One-off: recheck the leads now in Need Review for the reasons fixed above.
INSERT INTO private.lead_ai_recheck_queue (lead_id, reason)
SELECT q.id, 'need_review_fixes'
FROM public.qualified_leads q
JOIN public.lead_ai_status a ON a.lead_id = q.id
WHERE q.ai_review_required
  AND public.cs_status_ai_may_change(q.cs_status, q.cs_status_updated_by_ai, q.cs_status_human_updated_at)
  AND a.reason_code IN ('model_unavailable', 'invalid_model_response', 'insufficient_evidence',
                        'no_matching_quo_history', 'no_contact_yet', 'delivery_not_confirmed',
                        'invalid_or_excess_customer_numbers', 'phone_shared_between_leads')
ON CONFLICT (lead_id) DO UPDATE SET reason = excluded.reason, requested_at = now();
