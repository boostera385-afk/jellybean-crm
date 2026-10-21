-- Full-account shadow sync: encrypted, short-lived checkpoints; no manual-status writes.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO service_role;
ALTER TABLE public.lead_ai_status_runs ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.lead_ai_status_runs
  ADD COLUMN requested_via text NOT NULL DEFAULT 'user' CHECK (requested_via IN ('user','management')),
  ADD COLUMN work_done integer NOT NULL DEFAULT 0 CHECK (work_done >= 0),
  ADD COLUMN work_total integer NOT NULL DEFAULT 0 CHECK (work_total >= work_done),
  ADD COLUMN last_progress_at timestamptz;
CREATE INDEX lead_ai_status_runs_started ON public.lead_ai_status_runs(started_at DESC);

CREATE TABLE private.quo_ai_sync_jobs (
  run_id uuid PRIMARY KEY REFERENCES public.lead_ai_status_runs(id) ON DELETE CASCADE,
  inbox_ids text[] NOT NULL CHECK (cardinality(inbox_ids) BETWEEN 1 AND 100),
  encrypted_checkpoint text CHECK (length(encrypted_checkpoint) <= 400000),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day'
);
ALTER TABLE private.quo_ai_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.quo_ai_sync_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.quo_ai_sync_jobs TO service_role;
CREATE POLICY "Only backend workers access encrypted staging" ON private.quo_ai_sync_jobs
  TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION public.expire_quo_ai_jobs() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  UPDATE public.lead_ai_status_runs r SET outcome='expired', finished_at=now()
  WHERE r.outcome='running' AND (
    EXISTS (SELECT 1 FROM private.quo_ai_sync_jobs j WHERE j.run_id=r.id AND j.expires_at < now())
    OR (r.started_at < now()-interval '4 minutes' AND NOT EXISTS
      (SELECT 1 FROM private.quo_ai_sync_jobs j WHERE j.run_id=r.id)));
  DELETE FROM private.quo_ai_sync_jobs j USING public.lead_ai_status_runs r
    WHERE r.id=j.run_id AND r.outcome <> 'running';
END $$;

CREATE FUNCTION public.enqueue_quo_ai_batch(p_actor_id uuid, p_inbox_ids text[],
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_lead_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run uuid; remaining integer; queued integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  -- NULL actor is an explicit service-only management test, never a browser-supplied identity.
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
    WHERE (p_from IS NULL OR q.assigned_at>=p_from) AND (p_to IS NULL OR q.assigned_at<p_to)
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

CREATE FUNCTION public.claim_quo_ai_job() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE j private.quo_ai_sync_jobs; r public.lead_ai_status_runs; q public.qualified_leads; lease uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  PERFORM public.expire_quo_ai_jobs();
  -- One Quo worker globally, including browser and cron invocations.
  IF EXISTS(SELECT 1 FROM private.quo_ai_sync_jobs WHERE lease_until>now()) THEN RETURN NULL; END IF;
  FOR j IN SELECT * FROM private.quo_ai_sync_jobs WHERE next_attempt_at<=now()
    ORDER BY created_at,run_id FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO r FROM public.lead_ai_status_runs WHERE id=j.run_id;
    SELECT * INTO q FROM public.qualified_leads WHERE id=r.lead_id;
    IF NOT FOUND OR r.source_key<>public.lead_ai_source_key(q)
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

CREATE FUNCTION public.checkpoint_quo_ai_job(p_run_id uuid,p_lease_token uuid,p_checkpoint text,
  p_done integer,p_total integer,p_retry boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE j private.quo_ai_sync_jobs;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  SELECT * INTO j FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until IS NULL OR j.lease_until<=now() OR j.expires_at<=now() THEN RETURN false; END IF;
  IF p_checkpoint IS NULL OR length(p_checkpoint)>400000
    OR p_checkpoint !~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'
    OR p_done<0 OR p_total<p_done OR p_total>300 THEN
    RAISE EXCEPTION 'Invalid checkpoint';
  END IF;
  UPDATE private.quo_ai_sync_jobs SET encrypted_checkpoint=p_checkpoint,lease_token=NULL,lease_until=NULL,
    next_attempt_at=now()+CASE WHEN p_retry THEN interval '1 minute' ELSE interval '2 seconds' END,
    failures=failures+CASE WHEN p_retry THEN 1 ELSE 0 END WHERE run_id=p_run_id;
  UPDATE public.lead_ai_status_runs SET work_done=p_done,work_total=p_total,last_progress_at=now()
    WHERE id=p_run_id;
  RETURN true;
END $$;

CREATE FUNCTION public.finish_quo_ai_job(p_run_id uuid,p_lease_token uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE j private.quo_ai_sync_jobs; r public.lead_ai_status_runs; q public.qualified_leads;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  SELECT * INTO j FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until IS NULL OR j.lease_until<=now() OR j.expires_at<=now() THEN RETURN false; END IF;
  SELECT * INTO r FROM public.lead_ai_status_runs WHERE id=p_run_id FOR UPDATE;
  SELECT * INTO q FROM public.qualified_leads WHERE id=r.lead_id FOR SHARE;
  IF NOT FOUND OR r.outcome<>'running' OR r.source_key<>public.lead_ai_source_key(q)
    OR (r.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.user_roles
      WHERE user_id=r.actor_id AND role::text IN ('admin','sub_admin','cs_admin'))) THEN
    UPDATE public.lead_ai_status_runs SET outcome='stale',finished_at=now() WHERE id=p_run_id;
    DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
    RETURN false;
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
  -- No message content survives completion; audit holds only status and evidence IDs.
  DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
  RETURN true;
END $$;

CREATE FUNCTION public.report_quo_ai_progress(p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT jsonb_build_object('pending',count(*),'workDone',coalesce(sum(r.work_done),0),
    'workTotal',coalesce(sum(r.work_total),0))
  FROM public.lead_ai_status_runs r JOIN public.qualified_leads q ON q.id=r.lead_id
  WHERE r.outcome='running' AND (p_from IS NULL OR q.assigned_at>=p_from) AND (p_to IS NULL OR q.assigned_at<p_to)
$$;

REVOKE ALL ON FUNCTION public.expire_quo_ai_jobs(),public.enqueue_quo_ai_batch(uuid,text[],timestamptz,timestamptz,uuid),
  public.claim_quo_ai_job(),public.checkpoint_quo_ai_job(uuid,uuid,text,integer,integer,boolean),
  public.finish_quo_ai_job(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.expire_quo_ai_jobs(),public.enqueue_quo_ai_batch(uuid,text[],timestamptz,timestamptz,uuid),
  public.claim_quo_ai_job(),public.checkpoint_quo_ai_job(uuid,uuid,text,integer,integer,boolean),
  public.finish_quo_ai_job(uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.report_quo_ai_progress(timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.report_quo_ai_progress(timestamptz,timestamptz) TO authenticated,service_role;

-- Reuse the existing Vault-held trusted worker key; never embed a key in cron text.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
    AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
    PERFORM cron.schedule('quo-ai-resume','* * * * *',$cron$
      SELECT net.http_post(
        url:=(SELECT regexp_replace(decrypted_secret,'/crisp-auto-greet/?$','/quo-ai-status')
          FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_url'),
        headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_key')),
        body:='{"action":"work"}'::jsonb,timeout_milliseconds:=85000)
      WHERE EXISTS(SELECT 1 FROM private.quo_ai_sync_jobs WHERE next_attempt_at<=now())
        AND NOT EXISTS(SELECT 1 FROM private.quo_ai_sync_jobs WHERE lease_until>now())
        AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_url'
          AND decrypted_secret LIKE '%/functions/v1/crisp-auto-greet')
        AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_key');
    $cron$);
    PERFORM cron.schedule('quo-ai-checkpoint-cleanup','23 * * * *','SELECT public.expire_quo_ai_jobs()');
  END IF;
END $$;
