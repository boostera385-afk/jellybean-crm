-- AI may only change a status it owns, or Delivered.
--
-- Pipeline automation starts when a person marks a lead Delivered; from then
-- on the AI moves it along. But a classified run (and the 6h no-reply flip)
-- also overwrote a final status a PERSON had chosen afterwards, e.g. a manual
-- "Interested" replaced by the AI's verdict on the next recheck. With the v7
-- prompt every automated lead is re-read once, so that has to be safe first.
--
-- The AI may now change cs_status only when it is Delivered (the hand-off
-- point), was last set by the AI, or was never set by a person. A person's own
-- decision stays; the AI's verdict is still recorded in lead_ai_status and
-- shown as the suggestion next to it.

CREATE OR REPLACE FUNCTION public.cs_status_ai_may_change(
  p_status public.cs_status,
  p_updated_by_ai boolean,
  p_human_updated_at timestamptz
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_status = 'converted'::public.cs_status
      OR p_updated_by_ai IS TRUE
      OR p_human_updated_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.finish_quo_ai_job(
  p_run_id uuid,
  p_lease_token uuid,
  p_result jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
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
  IF NOT FOUND OR q.cs_status='need_follow_up' OR r.outcome<>'running'
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
  IF p_result->>'status'='need_follow_up' THEN
    p_result := p_result || jsonb_build_object(
      'state','review','status',NULL,'confidence',NULL,
      'reasonCode','manual_follow_up','evidenceIds','[]'::jsonb,'historyHash',NULL
    );
  END IF;

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
    ELSIF v_state IN ('review','error') THEN
      -- Only flag a lead that is not already owned by a person: a human-set
      -- status must never reappear in Need Review.
      UPDATE public.qualified_leads
      SET ai_review_required = true,
          ai_review_reason = v_reason
      WHERE id = r.lead_id
        AND NOT (cs_status_updated_by_ai = false AND cs_status_human_updated_at IS NOT NULL);
    END IF;
  END IF;

  UPDATE public.lead_ai_status_runs
  SET outcome=v_state,result=p_result,finished_at=now(),
      work_done=work_total,last_progress_at=now()
  WHERE id=p_run_id;
  DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.flip_quo_ai_no_reply()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE flipped integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM private.quo_webhook_deliveries
    WHERE received_at > now() - interval '24 hours'
  ) THEN
    RETURN 0;
  END IF;

  WITH flipped_rows AS (
    UPDATE public.lead_ai_status a
       SET ai_status = 'cx_didnt_replied'::public.cs_status,
           reason_code = 'no_reply_after_6h',
           analyzed_at = now()
      FROM public.qualified_leads q
     WHERE q.id = a.lead_id
       AND q.ai_status_automation_started_at IS NOT NULL
       AND q.created_at >= public.quo_ai_scope_start()
       AND a.state = 'classified'
       AND a.ai_status = 'converted'::public.cs_status
       AND a.reason_code = 'delivery_confirmed'
       AND a.last_message_at IS NOT NULL
       AND a.last_message_at < now() - interval '6 hours'
       AND a.source_key = public.lead_ai_source_key(q)
       AND NOT EXISTS (
         SELECT 1 FROM private.lead_ai_recheck_queue rq WHERE rq.lead_id = a.lead_id
       )
    RETURNING a.lead_id
  )
  UPDATE public.qualified_leads q
  SET cs_status = 'cx_didnt_replied'::public.cs_status,
      cs_status_updated_by_ai = true,
      cs_status_ai_updated_at = now(),
      ai_review_required = false,
      ai_review_reason = NULL
  FROM flipped_rows f
  WHERE q.id = f.lead_id
    AND public.cs_status_ai_may_change(q.cs_status, q.cs_status_updated_by_ai,
                                       q.cs_status_human_updated_at);
  GET DIAGNOSTICS flipped = ROW_COUNT;
  RETURN flipped;
END
$$;

NOTIFY pgrst, 'reload schema';
