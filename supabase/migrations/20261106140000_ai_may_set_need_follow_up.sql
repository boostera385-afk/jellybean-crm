-- Let the AI move a lead to Need Follow Up, and keep re-reading it.
--
-- Until now Need Follow Up was manual-only: the AI could never suggest it, and
-- a lead in it was dropped from every AI read. The team now wants the AI to use
-- it for customers who are undecided or holding us in reserve ("someone is
-- coming but I'll let you know if he can't", "still exploring options",
-- "getting a few quotes"). Those leads change later, so the AI must keep
-- reading them.
--
-- A person's own Need Follow Up stays exactly as before: locked from the AI.
-- Only a Need Follow Up the AI set itself is re-read and may be changed.

CREATE OR REPLACE FUNCTION public.cs_status_ai_locked(
  p_status public.cs_status,
  p_updated_by_ai boolean
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_status = 'need_follow_up'::public.cs_status AND p_updated_by_ai IS NOT TRUE
$$;

ALTER TABLE public.lead_ai_status DROP CONSTRAINT lead_ai_status_ai_status_check;
ALTER TABLE public.lead_ai_status ADD CONSTRAINT lead_ai_status_ai_status_check CHECK (
  ai_status IS NULL OR ai_status::text IN (
    'new','undeliver','wrong_number','wrong_lead','already_got_someone',
    'already_received_before','service_provider_himself','converted',
    'cx_interested','cx_not_interested','cx_didnt_replied','need_follow_up','out_of_base'
  )
);

CREATE OR REPLACE FUNCTION public.tg_canonical_ai_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.ai_status := public.canonical_cs_status(NEW.ai_status);
  IF EXISTS (
    SELECT 1 FROM public.qualified_leads q
    WHERE q.id = NEW.lead_id
      AND public.cs_status_ai_locked(q.cs_status, q.cs_status_updated_by_ai)
  ) THEN
    NEW.ai_status := NULL;
    NEW.state := 'review';
    NEW.confidence := NULL;
    NEW.reason_code := 'manual_follow_up';
    NEW.evidence_ids := '{}';
    NEW.history_hash := NULL;
  END IF;
  RETURN NEW;
END $$;

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

-- The queue, claim, webhook and report functions skip only a person's own
-- Need Follow Up. Rewritten in place so nothing else in them changes.
DO $$
DECLARE
  fn text;
  def text;
  patched text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.accept_quo_webhook_event(text,text,text,text,text,text[])',
    'public.claim_quo_ai_job()',
    'public.enqueue_quo_ai_batch(uuid,text[],timestamptz,timestamptz,uuid)',
    'public.enqueue_quo_ai_due(text[],integer,text)',
    'public.report_lead_ai_status(timestamptz,timestamptz)'
  ] LOOP
    def := pg_get_functiondef(fn::regprocedure);
    patched := replace(def, 'q.cs_status <> ''need_follow_up''',
      'NOT public.cs_status_ai_locked(q.cs_status, q.cs_status_updated_by_ai)');
    patched := replace(patched, 'q.cs_status=''need_follow_up''',
      'public.cs_status_ai_locked(q.cs_status, q.cs_status_updated_by_ai)');
    IF patched = def OR position('''need_follow_up''' IN patched) > 0 THEN
      RAISE EXCEPTION 'Unexpected definition of %', fn;
    END IF;
    EXECUTE patched;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
