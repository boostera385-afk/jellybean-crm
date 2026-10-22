-- Shadow-mode beta: no writes to qualified_leads.cs_status and no enum renames.
CREATE TABLE public.lead_ai_status_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.qualified_leads(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  source_key text NOT NULL,
  manual_status public.cs_status NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running','classified','review','unmatched','error','expired','stale')),
  result jsonb
);
CREATE UNIQUE INDEX lead_ai_status_one_running ON public.lead_ai_status_runs(lead_id)
  WHERE outcome = 'running';
CREATE INDEX lead_ai_status_runs_lead_time ON public.lead_ai_status_runs(lead_id, started_at DESC);
CREATE INDEX lead_ai_status_runs_actor_time ON public.lead_ai_status_runs(actor_id, started_at DESC);

CREATE TABLE public.lead_ai_status (
  lead_id uuid PRIMARY KEY REFERENCES public.qualified_leads(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.lead_ai_status_runs(id),
  source_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('classified','review','unmatched','error')),
  ai_status public.cs_status,
  confidence double precision CHECK (confidence >= 0 AND confidence <= 1),
  reason_code text NOT NULL CHECK (length(reason_code) <= 80),
  evidence_ids text[] NOT NULL DEFAULT '{}',
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  history_hash text,
  model text NOT NULL,
  policy_version text NOT NULL,
  analyzed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'classified') = (ai_status IS NOT NULL)),
  CHECK (ai_status IS NULL OR ai_status::text IN (
    'new','undeliver','wrong_number','wrong_lead','wrong_service','wrong_person',
    'already_got_someone','already_received_before','service_provider_himself','small_service',
    'converted','cx_interested','cx_not_interested','cx_didnt_replied','need_follow_up','out_of_base'
  ))
);
CREATE INDEX qualified_leads_important_assigned ON public.qualified_leads(assigned_at DESC)
  WHERE is_important = true;
ALTER TABLE public.lead_ai_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_ai_status_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_ai_status, public.lead_ai_status_runs FROM anon, authenticated;
GRANT SELECT ON public.lead_ai_status, public.lead_ai_status_runs TO authenticated;
GRANT ALL ON public.lead_ai_status, public.lead_ai_status_runs TO service_role;
CREATE POLICY "AI results follow lead access" ON public.lead_ai_status FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.qualified_leads q WHERE q.id = lead_id));
CREATE POLICY "AI audit for reporting administrators" ON public.lead_ai_status_runs FOR SELECT TO authenticated
  USING ((SELECT public.current_user_has_role_text('admin'))
    OR (SELECT public.current_user_has_role_text('sub_admin'))
    OR (SELECT public.current_user_has_role_text('cs_admin')));

-- Manual status/notes changes do not invalidate a comparison. Changes to the
-- customer, assignment or classification context do invalidate it.
CREATE FUNCTION public.lead_ai_source_key(q public.qualified_leads) RETURNS text
  LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT md5(jsonb_build_array(q.customer_number, q.customer_number_2, q.extra_numbers,
    q.assigned_at, q.service, q.post_text, q.context)::text)
$$;
REVOKE ALL ON FUNCTION public.lead_ai_source_key(public.qualified_leads) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_ai_source_key(public.qualified_leads) TO authenticated, service_role;

CREATE FUNCTION public.claim_lead_ai_batch(p_actor_id uuid, p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL, p_lead_id uuid DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run_id uuid; batch jsonb := '[]'; remaining integer;
BEGIN
  -- Serialize reservation only, not network/model work. Global bounded spend.
  PERFORM pg_advisory_xact_lock(20261021, 61);
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor_id
    AND role::text IN ('admin','sub_admin','cs_admin')) THEN
    RAISE EXCEPTION 'AI reporting access required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.lead_ai_status_runs SET outcome = 'expired', finished_at = now()
    WHERE outcome = 'running' AND started_at < now() - interval '4 minutes';
  SELECT least(5,
    5 - count(*) FILTER (WHERE started_at > now() - interval '1 minute'),
    500 - count(*))::integer INTO remaining
    FROM public.lead_ai_status_runs WHERE started_at > now() - interval '1 day';
  IF remaining <= 0 THEN RETURN batch; END IF;
  FOR picked IN
    SELECT q.*, public.lead_ai_source_key(q) AS ai_source_key
    FROM public.qualified_leads q
    LEFT JOIN LATERAL (SELECT r.started_at FROM public.lead_ai_status_runs r
      WHERE r.lead_id = q.id ORDER BY r.started_at DESC LIMIT 1) last_run ON true
    WHERE (p_from IS NULL OR q.assigned_at >= p_from) AND (p_to IS NULL OR q.assigned_at < p_to)
      AND (p_lead_id IS NULL OR q.id = p_lead_id)
      AND (last_run.started_at IS NULL OR last_run.started_at < now() - interval '15 minutes')
      AND NOT EXISTS (SELECT 1 FROM public.lead_ai_status_runs r WHERE r.lead_id = q.id AND r.outcome = 'running')
    ORDER BY last_run.started_at ASC NULLS FIRST, q.assigned_at DESC, q.id
    LIMIT remaining
  LOOP
    INSERT INTO public.lead_ai_status_runs(lead_id, actor_id, source_key, manual_status)
      VALUES (picked.id, p_actor_id, picked.ai_source_key, picked.cs_status) RETURNING id INTO run_id;
    batch := batch || jsonb_build_array(jsonb_build_object('runId', run_id, 'leadId', picked.id,
      'sourceKey', picked.ai_source_key, 'customerNumber', picked.customer_number,
      'customerNumber2', picked.customer_number_2, 'extraNumbers', picked.extra_numbers,
      'service', picked.service, 'assignedAt', picked.assigned_at));
  END LOOP;
  RETURN batch;
END $$;
REVOKE ALL ON FUNCTION public.claim_lead_ai_batch(uuid,timestamptz,timestamptz,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_ai_batch(uuid,timestamptz,timestamptz,uuid) TO service_role;

-- Atomic fenced completion: an expired worker or edited lead cannot publish.
CREATE FUNCTION public.finish_lead_ai_run(p_run_id uuid, p_result jsonb) RETURNS boolean
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE r public.lead_ai_status_runs; q public.qualified_leads;
BEGIN
  SELECT * INTO r FROM public.lead_ai_status_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.outcome <> 'running' OR r.started_at < now() - interval '4 minutes' THEN RETURN false; END IF;
  SELECT * INTO q FROM public.qualified_leads WHERE id = r.lead_id FOR SHARE;
  IF NOT FOUND OR public.lead_ai_source_key(q) <> r.source_key THEN
    UPDATE public.lead_ai_status_runs SET outcome = 'stale', finished_at = now() WHERE id = r.id;
    RETURN false;
  END IF;
  INSERT INTO public.lead_ai_status(lead_id,run_id,source_key,state,ai_status,confidence,reason_code,
    evidence_ids,message_count,history_hash,model,policy_version)
  VALUES (r.lead_id,r.id,r.source_key,p_result->>'state',(p_result->>'status')::public.cs_status,
    (p_result->>'confidence')::double precision,p_result->>'reasonCode',
    ARRAY(SELECT jsonb_array_elements_text(p_result->'evidenceIds')),
    (p_result->>'messageCount')::integer,p_result->>'historyHash',p_result->>'model',p_result->>'policyVersion')
  ON CONFLICT (lead_id) DO UPDATE SET run_id = EXCLUDED.run_id, source_key = EXCLUDED.source_key,
    state = EXCLUDED.state, ai_status = EXCLUDED.ai_status, confidence = EXCLUDED.confidence,
    reason_code = EXCLUDED.reason_code, evidence_ids = EXCLUDED.evidence_ids,
    message_count = EXCLUDED.message_count, history_hash = EXCLUDED.history_hash,
    model = EXCLUDED.model, policy_version = EXCLUDED.policy_version, analyzed_at = now();
  UPDATE public.lead_ai_status_runs SET outcome = p_result->>'state', result = p_result,
    finished_at = now() WHERE id = r.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_lead_ai_run(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_lead_ai_run(uuid,jsonb) TO service_role;

-- Single scan and the same assigned_at half-open range as manual reports.
CREATE FUNCTION public.report_lead_ai_status(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH scoped AS (
    SELECT q.cs_status, q.customer_name, a.*, a.source_key = public.lead_ai_source_key(q) AS fresh
    FROM public.qualified_leads q LEFT JOIN public.lead_ai_status a ON a.lead_id = q.id
    WHERE (p_from IS NULL OR q.assigned_at >= p_from) AND (p_to IS NULL OR q.assigned_at < p_to)
  ), counts AS (
    SELECT ai_status::text AS status, count(*) AS n FROM scoped
    WHERE state = 'classified' AND fresh GROUP BY ai_status
  ) SELECT jsonb_build_object(
    'counts', COALESCE((SELECT jsonb_object_agg(status,n) FROM counts),'{}'::jsonb),
    'total', count(*),
    'classified', count(*) FILTER (WHERE state = 'classified' AND fresh),
    'disagreements', count(*) FILTER (WHERE state = 'classified' AND fresh AND ai_status <> cs_status),
    'review', count(*) FILTER (WHERE state IN ('review','unmatched','error') AND fresh),
    'stale', count(*) FILTER (WHERE lead_id IS NOT NULL AND NOT fresh),
    'samples', COALESCE((SELECT jsonb_agg(item) FROM (
      SELECT jsonb_build_object('leadId',lead_id,'customerName',customer_name,
        'manualStatus',cs_status,'aiStatus',ai_status,'state',state,'confidence',confidence,
        'reasonCode',reason_code,'analyzedAt',analyzed_at) AS item
      FROM scoped WHERE fresh AND (state <> 'classified' OR ai_status <> cs_status)
      ORDER BY analyzed_at DESC, lead_id LIMIT 10
    ) examples),'[]'::jsonb),
    'lastAnalyzedAt', max(analyzed_at)
  ) FROM scoped
$$;
REVOKE ALL ON FUNCTION public.report_lead_ai_status(timestamptz,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_lead_ai_status(timestamptz,timestamptz) TO authenticated, service_role;

-- Exact conservative identity guard across primary, secondary and extra numbers.
CREATE FUNCTION public.lead_ai_phone(p_phone text) RETURNS text
  LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT CASE WHEN p_phone !~ '^[\s()+.\-0-9]+$' THEN NULL
    WHEN p_phone ~ '^\s*\+[1-9]' AND length(regexp_replace(p_phone,'[^0-9]','','g')) BETWEEN 8 AND 15
      THEN '+' || regexp_replace(p_phone,'[^0-9]','','g')
    WHEN length(regexp_replace(p_phone,'[^0-9]','','g')) = 10 THEN '+1' || regexp_replace(p_phone,'[^0-9]','','g')
    WHEN length(regexp_replace(p_phone,'[^0-9]','','g')) = 11 AND regexp_replace(p_phone,'[^0-9]','','g') LIKE '1%'
      THEN '+' || regexp_replace(p_phone,'[^0-9]','','g') ELSE NULL END
$$;
REVOKE ALL ON FUNCTION public.lead_ai_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_ai_phone(text) TO service_role;
CREATE INDEX qualified_leads_ai_phone_1 ON public.qualified_leads(public.lead_ai_phone(customer_number));
CREATE INDEX qualified_leads_ai_phone_2 ON public.qualified_leads(public.lead_ai_phone(customer_number_2));
CREATE FUNCTION public.lead_ai_phone_is_unique(p_lead_id uuid, p_phone text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.qualified_leads q WHERE q.id <> p_lead_id
    AND (public.lead_ai_phone(q.customer_number) = p_phone
      OR public.lead_ai_phone(q.customer_number_2) = p_phone
      OR EXISTS (SELECT 1 FROM unnest(q.extra_numbers) n WHERE public.lead_ai_phone(n) = p_phone)))
$$;
REVOKE ALL ON FUNCTION public.lead_ai_phone_is_unique(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_ai_phone_is_unique(uuid,text) TO service_role;
