-- Need Review must only contain leads WITHOUT a manual status.
--
-- The automation already clears the review flag when a person changes a status
-- (the status-provenance trigger). But a lead a human had already set could
-- still be flagged by a later AI "review" verdict, because the finish function
-- raised ai_review_required without checking who owns the status. This migration
-- closes that: a lead whose current status was set by a person (not the AI) is
-- theirs and never enters Need Review -- in the writer, the count, and the list.
--
-- "Owned by a human" = cs_status_updated_by_ai = false AND the status has been
-- changed by a person at least once (cs_status_human_updated_at IS NOT NULL).

-- ── One-time cleanup: drop the flag from any lead a human already owns ───────
UPDATE public.qualified_leads
   SET ai_review_required = false, ai_review_reason = NULL
 WHERE ai_review_required
   AND cs_status_updated_by_ai = false
   AND cs_status_human_updated_at IS NOT NULL;

-- ── finish_quo_ai_job: never raise the review flag on a human-owned lead ─────
-- Identical to 20261104092301 apart from the WHERE guard on the review branch.
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

-- ── cs_leads_status_counts_filtered: Need Review count excludes human-owned ──
-- Identical to 20261104092301 apart from the two extra columns in the filtered
-- CTE and the guard on the needsReview count.
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
    SELECT q.cs_status,q.ai_review_required,q.cs_status_updated_by_ai,q.cs_status_human_updated_at
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
    'needsReview', (SELECT count(*)::bigint FROM filtered
      WHERE ai_review_required
        AND NOT (cs_status_updated_by_ai = false AND cs_status_human_updated_at IS NOT NULL)),
    'statuses', coalesce(jsonb_object_agg(cs_status::text,status_count),'{}'::jsonb)
  ) INTO result FROM counts;
  RETURN coalesce(result,jsonb_build_object('all',0,'needsReview',0,'statuses','{}'::jsonb));
END
$$;

NOTIFY pgrst, 'reload schema';
