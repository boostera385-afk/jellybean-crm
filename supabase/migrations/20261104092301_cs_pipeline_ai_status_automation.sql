-- Promote Quo AI from a comparison-only report to a guarded CS-pipeline
-- automation. Existing cs_status enum identifiers remain unchanged.
--
-- A lead is eligible only after a person has put it in Delivered (`converted`)
-- at least once. From then on a completed AI run may update the same status
-- column. The provenance columns make that visible in the pipeline, while an
-- inconclusive run leaves the current status alone and opens Needs Review.

ALTER TABLE public.qualified_leads
  ADD COLUMN ai_status_automation_started_at timestamptz,
  ADD COLUMN cs_status_updated_by_ai boolean NOT NULL DEFAULT false,
  ADD COLUMN cs_status_ai_updated_at timestamptz,
  ADD COLUMN cs_status_human_updated_at timestamptz,
  ADD COLUMN ai_review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_review_reason text;

CREATE INDEX qualified_leads_ai_review_required_idx
  ON public.qualified_leads (assigned_at DESC)
  WHERE ai_review_required IS TRUE;

-- Every Delivered status that existed before this migration was necessarily
-- selected by a person because the old AI path never wrote cs_status.
UPDATE public.qualified_leads
SET ai_status_automation_started_at = COALESCE(updated_at, assigned_at, now()),
    cs_status_human_updated_at = COALESCE(updated_at, assigned_at, now())
WHERE cs_status = 'converted'::public.cs_status;

-- A normal signed-in user changing a status owns that decision: remove the AI
-- marker and close any review request. service_role is reserved for the fenced
-- worker functions below, which set their own provenance explicitly.
CREATE FUNCTION public.tg_qualified_lead_status_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.cs_status IS DISTINCT FROM OLD.cs_status
     AND current_user <> 'service_role' THEN
    NEW.cs_status_updated_by_ai := false;
    NEW.cs_status_ai_updated_at := NULL;
    NEW.cs_status_human_updated_at := now();
    NEW.ai_review_required := false;
    NEW.ai_review_reason := NULL;
    IF NEW.cs_status = 'converted'::public.cs_status
       AND OLD.ai_status_automation_started_at IS NULL THEN
      NEW.ai_status_automation_started_at := now();
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.tg_qualified_lead_status_provenance() FROM PUBLIC;

CREATE TRIGGER qualified_lead_status_provenance
  BEFORE UPDATE OF cs_status ON public.qualified_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_qualified_lead_status_provenance();

-- Keep the existing lease, source and actor fences. A human status change made
-- after a run began additionally makes that run stale, so a slow AI response
-- cannot overwrite a decision somebody just made.
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
      WHERE id = r.lead_id;
    ELSIF v_state IN ('review','error') THEN
      UPDATE public.qualified_leads
      SET ai_review_required = true,
          ai_review_reason = v_reason
      WHERE id = r.lead_id;
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

-- Once delivery has been quiet for six hours, advance both the audit record
-- and the live status without another provider call.
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
  WHERE q.id = f.lead_id;
  GET DIAGNOSTICS flipped = ROW_COUNT;
  RETURN flipped;
END
$$;

-- Preserve the reach-out counters for every matching lead, but only queue AI
-- work after Delivered has enabled automation for that lead.
CREATE OR REPLACE FUNCTION public.accept_quo_webhook_event(
  p_webhook_id text,
  p_event_type text,
  p_phone text,
  p_direction text DEFAULT NULL,
  p_category text DEFAULT 'message'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  normalized text;
  v_reason text;
  inserted integer;
  matched integer := 0;
  v_category text := COALESCE(NULLIF(p_category, ''), 'message');
  v_direction text;
BEGIN
  IF p_webhook_id IS NULL OR length(p_webhook_id) NOT BETWEEN 1 AND 200
    OR p_event_type IS NULL OR length(p_event_type) > 80 THEN
    RAISE EXCEPTION 'Invalid webhook event';
  END IF;
  IF v_category NOT IN ('message', 'call') THEN RAISE EXCEPTION 'Invalid event category'; END IF;
  v_direction := CASE
    WHEN p_direction IN ('inbound', 'outbound') THEN p_direction
    WHEN p_event_type = 'message.received' THEN 'inbound'
    WHEN p_event_type IN ('message.delivered', 'message.undelivered') THEN 'outbound'
    ELSE NULL END;

  INSERT INTO private.quo_webhook_deliveries(webhook_id, event_type)
    VALUES (p_webhook_id, p_event_type) ON CONFLICT (webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true, 'matched', 0); END IF;

  normalized := public.lead_ai_phone(p_phone);
  IF normalized IS NULL THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'unparseable_phone');
  END IF;

  IF v_direction = 'inbound' THEN
    UPDATE public.qualified_leads q
       SET quo_first_reply_at = now(), quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  ELSIF v_direction = 'outbound' AND v_category = 'call' THEN
    UPDATE public.qualified_leads q
       SET quo_outbound_calls = q.quo_outbound_calls + 1, quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  ELSIF v_direction = 'outbound' AND p_event_type = 'message.delivered' THEN
    UPDATE public.qualified_leads q
       SET quo_outbound_messages = q.quo_outbound_messages + 1, quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  END IF;

  IF v_category <> 'message' THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'call_counted');
  END IF;
  v_reason := CASE p_event_type
    WHEN 'message.received' THEN 'customer_replied'
    WHEN 'message.undelivered' THEN 'delivery_failed'
    ELSE 'delivery_confirmed' END;

  WITH touched AS (
    INSERT INTO private.lead_ai_recheck_queue AS rq (lead_id, reason)
    SELECT q.id, v_reason
    FROM public.qualified_leads q
    WHERE q.cs_status <> 'need_follow_up'
      AND q.ai_status_automation_started_at IS NOT NULL
      AND q.created_at >= public.quo_ai_scope_start()
      AND (public.lead_ai_phone(q.customer_number) = normalized
        OR public.lead_ai_phone(q.customer_number_2) = normalized
        OR EXISTS (
          SELECT 1 FROM unnest(q.extra_numbers) n WHERE public.lead_ai_phone(n) = normalized
        ))
    ON CONFLICT (lead_id) DO UPDATE
      SET reason = excluded.reason, requested_at = now()
    RETURNING rq.lead_id
  )
  SELECT count(*)::integer INTO matched FROM touched;
  RETURN jsonb_build_object('duplicate', false, 'matched', matched, 'reason', v_reason);
END
$$;

-- Automatic sweeps only consider enabled leads. Starting automation is itself
-- a reason to refresh, even when a comparison existed before Delivered.
CREATE OR REPLACE FUNCTION public.enqueue_quo_ai_due(
  p_inbox_ids text[],
  p_limit integer DEFAULT 5,
  p_policy_version text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
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
            AND a.analyzed_at < now() - interval '10 minutes' THEN 3
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
      WHERE q.cs_status <> 'need_follow_up'
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
$$;

-- Counts are deliberately team-wide, matching the existing CS chips. Needs
-- Review is additive: those leads remain in their current status count too.
CREATE OR REPLACE FUNCTION public.cs_leads_status_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  requester_id uuid := (SELECT auth.uid());
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = requester_id AND role::text IN ('admin','sub_admin','cs','cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  WITH base AS MATERIALIZED (
    SELECT q.cs_status,q.ai_review_required FROM public.qualified_leads q
  ), counts AS (
    SELECT cs_status,count(*)::bigint AS status_count FROM base GROUP BY cs_status
  )
  SELECT jsonb_build_object(
    'all', (SELECT count(*)::bigint FROM base),
    'needsReview', (SELECT count(*)::bigint FROM base WHERE ai_review_required),
    'statuses', coalesce(jsonb_object_agg(cs_status::text,status_count),'{}'::jsonb)
  ) INTO result FROM counts;
  RETURN coalesce(result,jsonb_build_object('all',0,'needsReview',0,'statuses','{}'::jsonb));
END
$$;

CREATE OR REPLACE FUNCTION public.cs_leads_status_counts_filtered(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_owner uuid DEFAULT NULL,
  p_unassigned boolean DEFAULT false,
  p_not_called boolean DEFAULT false,
  p_important boolean DEFAULT false,
  p_search text DEFAULT NULL,
  p_phone text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
    SELECT q.cs_status,q.ai_review_required
    FROM public.qualified_leads q
    WHERE (p_date_from IS NULL OR q.assigned_at >= p_date_from)
      AND (p_date_to IS NULL OR q.assigned_at < p_date_to)
      AND CASE
        WHEN p_unassigned THEN q.assigned_to IS NULL
        WHEN p_owner IS NOT NULL THEN q.assigned_to = p_owner
        ELSE true END
      AND (NOT p_not_called OR (q.called_at IS NULL AND q.quo_outbound_calls = 0))
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
    'needsReview', (SELECT count(*)::bigint FROM filtered WHERE ai_review_required),
    'statuses', coalesce(jsonb_object_agg(cs_status::text,status_count),'{}'::jsonb)
  ) INTO result FROM counts;
  RETURN coalesce(result,jsonb_build_object('all',0,'needsReview',0,'statuses','{}'::jsonb));
END
$$;

NOTIFY pgrst, 'reload schema';
