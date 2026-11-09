-- Every automated lead leaves Delivered: a final status, or Need Review.
--
-- Leads sat in Delivered for good, neither updated nor in Need Review. From the
-- 7 Nov leads (29 of them in Delivered) the saved chats and status history show
-- three causes:
--
-- 1. The review flag skipped every lead a PERSON had marked Delivered. Marking
--    Delivered is what starts the automation, so this was nearly every lead.
--    The guard was meant to protect a person's own final decision, but it
--    treated Delivered (the hand-off point) as one. It now uses the same rule
--    as status changes, cs_status_ai_may_change: Delivered, AI-set, or never
--    set by a person. The Need Review count follows the same rule.
-- 2. "unmatched" results (no Quo history for the number, nothing sent this
--    assignment) were never flagged at all. On a Delivered lead that is a
--    problem a person has to look at, so it now goes to Need Review.
-- 3. (Edge function) A voicemail greeting on a call was read as the customer
--    speaking, so the AI found "no outcome" and returned review instead of
--    "didn't reply". Fixed in fetchQuoCalls; those leads are re-read below.
--
-- Also:
-- - A lead in review whose customer HAS replied no longer keeps an AI-set
--   "CX didn't replied" (it was left over from before the reply). It goes back
--   to Delivered while it waits in Need Review.
-- - "Delivery not confirmed" (Quo still says "sent") was re-read every ~15
--   minutes forever: 170 runs for one lead. It is re-checked for 24 hours after
--   the text; after that it simply stays in Need Review.

-- ── finish_quo_ai_job ────────────────────────────────────────────────────────
-- Identical to the live version apart from the review branch.
CREATE OR REPLACE FUNCTION public.finish_quo_ai_job(p_run_id uuid, p_lease_token uuid, p_result jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  j private.quo_ai_sync_jobs;
  r public.lead_ai_status_runs;
  q public.qualified_leads;
  v_state text;
  v_status public.cs_status;
  v_reason text;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  SELECT * INTO j FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until IS NULL OR j.lease_until<=now() OR j.expires_at<=now() THEN
    RETURN false;
  END IF;

  SELECT * INTO r FROM public.lead_ai_status_runs WHERE id=p_run_id FOR UPDATE;
  SELECT * INTO q FROM public.qualified_leads WHERE id=r.lead_id FOR SHARE;
  IF NOT FOUND OR public.cs_status_ai_locked(q.cs_status, q.cs_status_updated_by_ai) OR r.outcome<>'running'
    OR r.source_key<>public.lead_ai_source_key(q)
    OR (q.cs_status_human_updated_at IS NOT NULL AND q.cs_status_human_updated_at > r.started_at)
    OR (r.actor_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id=r.actor_id AND role::text IN ('admin','sub_admin','cs_admin')
    )) THEN
    UPDATE public.lead_ai_status_runs SET outcome='stale',finished_at=now() WHERE id=p_run_id;
    DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
    RETURN false;
  END IF;

  p_result := jsonb_set(
    p_result,
    '{status}',
    coalesce(to_jsonb(public.canonical_cs_status((p_result->>'status')::public.cs_status)), 'null'::jsonb)
  );
  INSERT INTO public.lead_ai_status(
    lead_id,run_id,source_key,state,ai_status,confidence,reason_code,
    evidence_ids,message_count,history_hash,model,policy_version,last_message_at
  ) VALUES (
    r.lead_id,r.id,r.source_key,p_result->>'state',(p_result->>'status')::public.cs_status,
    (p_result->>'confidence')::double precision,p_result->>'reasonCode',
    ARRAY(SELECT jsonb_array_elements_text(p_result->'evidenceIds')),
    (p_result->>'messageCount')::integer,p_result->>'historyHash',p_result->>'model',p_result->>'policyVersion',
    CASE WHEN p_result->>'lastMessageAt' IS NULL THEN NULL
         ELSE (p_result->>'lastMessageAt')::timestamptz END
  )
  ON CONFLICT(lead_id) DO UPDATE SET
    run_id=EXCLUDED.run_id,source_key=EXCLUDED.source_key,state=EXCLUDED.state,
    ai_status=EXCLUDED.ai_status,confidence=EXCLUDED.confidence,
    reason_code=EXCLUDED.reason_code,evidence_ids=EXCLUDED.evidence_ids,
    message_count=EXCLUDED.message_count,history_hash=EXCLUDED.history_hash,
    model=EXCLUDED.model,policy_version=EXCLUDED.policy_version,
    last_message_at=EXCLUDED.last_message_at,analyzed_at=now();

  v_state := p_result->>'state';
  v_status := (p_result->>'status')::public.cs_status;
  v_reason := coalesce(nullif(p_result->>'reasonCode',''), 'needs_human_review');

  IF q.ai_status_automation_started_at IS NOT NULL THEN
    IF v_state = 'classified' AND v_status IS NOT NULL THEN
      UPDATE public.qualified_leads
      SET cs_status = v_status,
          cs_status_updated_by_ai = true,
          cs_status_ai_updated_at = now(),
          ai_review_required = false,
          ai_review_reason = NULL
      WHERE id = r.lead_id
        AND public.cs_status_ai_may_change(cs_status, cs_status_updated_by_ai,
                                           cs_status_human_updated_at);
    ELSIF v_state IN ('review','error','unmatched') THEN
      -- Anything the AI could not settle goes to Need Review -- Delivered
      -- included -- unless a person has already chosen a final status.
      UPDATE public.qualified_leads
      SET ai_review_required = true,
          ai_review_reason = v_reason,
          -- "Didn't reply" set by the AI before the customer wrote back is no
          -- longer true; show Delivered while a person reviews the reply.
          cs_status = CASE
            WHEN cs_status = 'cx_didnt_replied'::public.cs_status
                 AND cs_status_updated_by_ai IS TRUE
                 AND (p_result->>'customerReplied')::boolean IS TRUE
            THEN 'converted'::public.cs_status ELSE cs_status END,
          cs_status_ai_updated_at = CASE
            WHEN cs_status = 'cx_didnt_replied'::public.cs_status
                 AND cs_status_updated_by_ai IS TRUE
                 AND (p_result->>'customerReplied')::boolean IS TRUE
            THEN now() ELSE cs_status_ai_updated_at END
      WHERE id = r.lead_id
        AND public.cs_status_ai_may_change(cs_status, cs_status_updated_by_ai,
                                           cs_status_human_updated_at);
    END IF;
  END IF;

  UPDATE public.lead_ai_status_runs
  SET outcome=v_state,result=p_result,finished_at=now(),
      work_done=work_total,last_progress_at=now()
  WHERE id=p_run_id;
  DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
  RETURN true;
END
$function$;

-- ── enqueue_quo_ai_due ───────────────────────────────────────────────────────
-- Identical to the live version apart from priority 3, which now stops 24
-- hours after the text (it re-read the same "sent" message without end).
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
          OR last_run.started_at < now() - interval '15 minutes'
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

-- ── cs_leads_status_counts_filtered: same Need Review rule as the list ───────
CREATE OR REPLACE FUNCTION public.cs_leads_status_counts_filtered(p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_owner uuid DEFAULT NULL::uuid, p_unassigned boolean DEFAULT false, p_not_called boolean DEFAULT false, p_important boolean DEFAULT false, p_search text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  requester_id uuid := (SELECT auth.uid());
  search_like text := CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL ELSE '%'||p_search||'%' END;
  phone_like text;
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = requester_id AND role::text IN ('admin','sub_admin','cs','cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  phone_like := coalesce(p_phone,search_like);

  WITH filtered AS MATERIALIZED (
    SELECT q.cs_status,q.ai_review_required,q.cs_status_updated_by_ai,q.cs_status_human_updated_at
    FROM public.qualified_leads q
    WHERE (p_date_from IS NULL OR q.assigned_at >= p_date_from)
      AND (p_date_to IS NULL OR q.assigned_at < p_date_to)
      AND CASE
        WHEN p_unassigned THEN q.assigned_to IS NULL
        WHEN p_owner IS NOT NULL THEN q.assigned_to = p_owner
        ELSE true END
      AND (NOT p_not_called OR (q.called_at IS NULL AND q.quo_last_call_at IS NULL AND q.quo_outbound_calls = 0))
      AND (NOT p_important OR q.is_important IS TRUE)
      AND (
        search_like IS NULL
        OR q.customer_name ILIKE search_like
        OR q.customer_number ILIKE phone_like
        OR q.customer_number_2 ILIKE phone_like
        OR q.number_name ILIKE search_like
        OR q.main_area ILIKE search_like
        OR q.sub_area ILIKE search_like
        OR q.pass_it_to ILIKE search_like
        OR q.requirement_1 ILIKE search_like
        OR q.requirement_2 ILIKE search_like
      )
  ), counts AS (
    SELECT cs_status,count(*)::bigint AS status_count FROM filtered GROUP BY cs_status
  )
  SELECT jsonb_build_object(
    'all', (SELECT count(*)::bigint FROM filtered),
    'needsReview', (SELECT count(*)::bigint FROM filtered
      WHERE ai_review_required
        AND public.cs_status_ai_may_change(cs_status, cs_status_updated_by_ai,
                                           cs_status_human_updated_at)),
    'statuses', coalesce(jsonb_object_agg(cs_status::text,status_count),'{}'::jsonb)
  ) INTO result FROM counts;
  RETURN coalesce(result,jsonb_build_object('all',0,'needsReview',0,'statuses','{}'::jsonb));
END
$function$;

-- ── One-time catch-up ────────────────────────────────────────────────────────
-- Flag every automated lead the AI left unsettled, then re-read them so the
-- voicemail fix can turn the "greeting only" ones into "didn't reply".
UPDATE public.qualified_leads q
   SET ai_review_required = true,
       ai_review_reason = coalesce(nullif(a.reason_code,''), 'needs_human_review')
  FROM public.lead_ai_status a
 WHERE a.lead_id = q.id
   AND a.state IN ('review','error','unmatched')
   AND q.ai_status_automation_started_at IS NOT NULL
   AND q.created_at >= public.quo_ai_scope_start()
   AND NOT public.cs_status_ai_locked(q.cs_status, q.cs_status_updated_by_ai)
   AND public.cs_status_ai_may_change(q.cs_status, q.cs_status_updated_by_ai,
                                      q.cs_status_human_updated_at)
   AND NOT q.ai_review_required;

INSERT INTO private.lead_ai_recheck_queue AS rq (lead_id, reason)
SELECT q.id, 'need_review_catch_up'
  FROM public.qualified_leads q
  JOIN public.lead_ai_status a ON a.lead_id = q.id
 WHERE a.state IN ('review','error','unmatched')
   AND q.ai_status_automation_started_at IS NOT NULL
   AND q.created_at >= public.quo_ai_scope_start()
   AND NOT public.cs_status_ai_locked(q.cs_status, q.cs_status_updated_by_ai)
   AND public.cs_status_ai_may_change(q.cs_status, q.cs_status_updated_by_ai,
                                      q.cs_status_human_updated_at)
ON CONFLICT (lead_id) DO NOTHING;
