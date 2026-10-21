-- Keep enum identifiers for saved integrations/audit history; normalize live tags.
CREATE FUNCTION public.canonical_cs_status(p_status public.cs_status)
RETURNS public.cs_status LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT CASE p_status::text
    WHEN 'wrong_person' THEN 'wrong_number'::public.cs_status
    WHEN 'wrong_service' THEN 'wrong_lead'::public.cs_status
    WHEN 'small_service' THEN 'wrong_lead'::public.cs_status
    ELSE p_status END
$$;
REVOKE ALL ON FUNCTION public.canonical_cs_status(public.cs_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.canonical_cs_status(public.cs_status) TO authenticated, service_role;

CREATE FUNCTION public.tg_canonical_cs_status() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  NEW.cs_status := public.canonical_cs_status(NEW.cs_status);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.tg_canonical_cs_status() FROM PUBLIC, anon;
CREATE TRIGGER trg_qualified_leads_canonical_status
  BEFORE INSERT OR UPDATE OF cs_status ON public.qualified_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_canonical_cs_status();

-- Update only the status: IDs, contacts, assignments, notes and history stay intact.
UPDATE public.qualified_leads SET cs_status = public.canonical_cs_status(cs_status)
WHERE cs_status IN ('wrong_person','wrong_service','small_service');

-- Protect against older, already-running workers during a rolling deployment.
CREATE FUNCTION public.tg_canonical_ai_status() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  NEW.ai_status := public.canonical_cs_status(NEW.ai_status);
  IF NEW.ai_status = 'need_follow_up' OR EXISTS (
    SELECT 1 FROM public.qualified_leads q WHERE q.id=NEW.lead_id AND q.cs_status='need_follow_up'
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
REVOKE ALL ON FUNCTION public.tg_canonical_ai_status() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_lead_ai_status_canonical
  BEFORE INSERT OR UPDATE ON public.lead_ai_status
  FOR EACH ROW EXECUTE FUNCTION public.tg_canonical_ai_status();

UPDATE public.lead_ai_status SET ai_status = ai_status
WHERE ai_status IN ('wrong_person','wrong_service','small_service','need_follow_up')
  OR lead_id IN (SELECT id FROM public.qualified_leads WHERE cs_status='need_follow_up');

ALTER TABLE public.lead_ai_status DROP CONSTRAINT lead_ai_status_ai_status_check;
ALTER TABLE public.lead_ai_status ADD CONSTRAINT lead_ai_status_ai_status_check CHECK (
  ai_status IS NULL OR ai_status::text IN (
    'new','undeliver','wrong_number','wrong_lead','already_got_someone',
    'already_received_before','service_provider_himself','converted',
    'cx_interested','cx_not_interested','cx_didnt_replied','out_of_base'
  )
);

-- No new follow-up work; existing jobs are fenced when claimed or completed.
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
      'assignedAt',q.assigned_at,'service',q.service);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.finish_quo_ai_job(p_run_id uuid,p_lease_token uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE j private.quo_ai_sync_jobs; r public.lead_ai_status_runs; q public.qualified_leads;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  SELECT * INTO j FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until IS NULL OR j.lease_until<=now() OR j.expires_at<=now() THEN RETURN false; END IF;
  SELECT * INTO r FROM public.lead_ai_status_runs WHERE id=p_run_id FOR UPDATE;
  SELECT * INTO q FROM public.qualified_leads WHERE id=r.lead_id FOR SHARE;
  IF NOT FOUND OR q.cs_status='need_follow_up' OR r.outcome<>'running' OR r.source_key<>public.lead_ai_source_key(q)
    OR (r.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.user_roles
      WHERE user_id=r.actor_id AND role::text IN ('admin','sub_admin','cs_admin'))) THEN
    UPDATE public.lead_ai_status_runs SET outcome='stale',finished_at=now() WHERE id=p_run_id;
    DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
    RETURN false;
  END IF;
  -- Normalize old worker results before both persistence and the audit record.
  p_result := jsonb_set(p_result,'{status}',coalesce(to_jsonb(
    public.canonical_cs_status((p_result->>'status')::public.cs_status)), 'null'::jsonb));
  IF p_result->>'status'='need_follow_up' THEN
    p_result := p_result || jsonb_build_object('state','review','status',NULL,'confidence',NULL,
      'reasonCode','manual_follow_up','evidenceIds','[]'::jsonb,'historyHash',NULL);
  END IF;
  INSERT INTO public.lead_ai_status(lead_id,run_id,source_key,state,ai_status,confidence,reason_code,
    evidence_ids,message_count,history_hash,model,policy_version)
  VALUES(r.lead_id,r.id,r.source_key,p_result->>'state',(p_result->>'status')::public.cs_status,
    (p_result->>'confidence')::double precision,p_result->>'reasonCode',
    ARRAY(SELECT jsonb_array_elements_text(p_result->'evidenceIds')),
    (p_result->>'messageCount')::integer,p_result->>'historyHash',p_result->>'model',p_result->>'policyVersion')
  ON CONFLICT(lead_id) DO UPDATE SET run_id=EXCLUDED.run_id,source_key=EXCLUDED.source_key,
    state=EXCLUDED.state,ai_status=EXCLUDED.ai_status,confidence=EXCLUDED.confidence,
    reason_code=EXCLUDED.reason_code,evidence_ids=EXCLUDED.evidence_ids,message_count=EXCLUDED.message_count,
    history_hash=EXCLUDED.history_hash,model=EXCLUDED.model,policy_version=EXCLUDED.policy_version,analyzed_at=now();
  UPDATE public.lead_ai_status_runs SET outcome=p_result->>'state',result=p_result,finished_at=now(),
    work_done=work_total,last_progress_at=now() WHERE id=p_run_id;
  DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.report_lead_ai_status(p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH scoped AS (
    SELECT q.cs_status, q.customer_name, a.*, a.source_key=public.lead_ai_source_key(q) AS fresh
    FROM public.qualified_leads q LEFT JOIN public.lead_ai_status a ON a.lead_id=q.id
    WHERE q.cs_status <> 'need_follow_up'
      AND (p_from IS NULL OR q.assigned_at>=p_from) AND (p_to IS NULL OR q.assigned_at<p_to)
  ), counts AS (
    SELECT ai_status::text AS status,count(*) AS n FROM scoped
    WHERE state='classified' AND fresh GROUP BY ai_status
  ) SELECT jsonb_build_object(
    'counts',coalesce((SELECT jsonb_object_agg(status,n) FROM counts),'{}'::jsonb),
    'total',count(*),
    'classified',count(*) FILTER (WHERE state='classified' AND fresh),
    'disagreements',count(*) FILTER (WHERE state='classified' AND fresh AND ai_status<>cs_status),
    'review',count(*) FILTER (WHERE state IN ('review','unmatched','error') AND fresh),
    'stale',count(*) FILTER (WHERE lead_id IS NOT NULL AND NOT fresh),
    'samples',coalesce((SELECT jsonb_agg(item) FROM (
      SELECT jsonb_build_object('leadId',lead_id,'customerName',customer_name,
        'manualStatus',cs_status,'aiStatus',ai_status,'state',state,'confidence',confidence,
        'reasonCode',reason_code,'analyzedAt',analyzed_at) AS item
      FROM scoped WHERE fresh AND (state<>'classified' OR ai_status<>cs_status)
      ORDER BY analyzed_at DESC,lead_id LIMIT 10
    ) examples),'[]'::jsonb),
    'lastAnalyzedAt',max(analyzed_at)
  ) FROM scoped
$$;

-- CREATE OR REPLACE preserves existing grants; state the intended access explicitly.
REVOKE ALL ON FUNCTION public.enqueue_quo_ai_batch(uuid,text[],timestamptz,timestamptz,uuid),
  public.claim_quo_ai_job(),public.finish_quo_ai_job(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_quo_ai_batch(uuid,text[],timestamptz,timestamptz,uuid),
  public.claim_quo_ai_job(),public.finish_quo_ai_job(uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.report_lead_ai_status(timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.report_lead_ai_status(timestamptz,timestamptz) TO authenticated,service_role;
