-- Event-driven Quo analysis: a webhook to react, a sweep to catch up, and the
-- 24-hour no-reply rule settled in SQL instead of by re-reading Quo.
--
-- Until now the only thing that ever queued work was an administrator pressing
-- "Refresh AI · next 5 leads": enqueue_quo_ai_batch() is reachable only from
-- the refresh action, and the every-minute cron posts {"action":"work"}, which
-- only resumes jobs that are ALREADY queued. So nothing happened unattended.
--
-- Three pieces, in the order they save work:
--
--   1. A webhook records that something happened to a phone number, resolves it
--      to leads through the existing indexed lead_ai_phone(), and parks them in
--      a recheck queue. Recording an event is cheap; scanning is not, so the
--      two are deliberately separate -- an event never waits on the spend
--      budget, and the budget is never spent on leads nothing happened to.
--
--   2. The sweep enqueues by NEED rather than round-robin. enqueue_quo_ai_batch
--      orders by last_run ASC, so it re-scans the whole catalogue forever at up
--      to (inboxes x phone numbers) paged Quo requests per lead -- for 39
--      inboxes that is up to 117 requests to re-learn nothing. The sweep here
--      only picks leads with a reason: an event, never classified, a delivery
--      that had not confirmed yet, an edited lead, or a 24-hour rule the flip
--      below could not apply. A lead with no reason is not queued at all.
--
--   3. cx_didnt_replied needs no provider call. "Delivered, no reply, 24h" is
--      arithmetic once the last message time is known, and no webhook can
--      report the passage of time. So last_message_at is persisted and a cron
--      flips those rows in place: no Quo requests, no model tokens.
--
-- Nothing here writes qualified_leads.cs_status. This stays comparison-only.

-- The last message the classification actually saw. transportResult's 24-hour
-- rule measures from here, so storing it makes the rule exact rather than
-- re-derivable only by fetching the whole history again.
ALTER TABLE public.lead_ai_status ADD COLUMN last_message_at timestamptz;

-- ── Webhook deliveries: idempotency and a liveness signal ───────────────────
-- Quo retries a delivery it did not see accepted, so the same event arrives
-- more than once. Keyed by webhook-id, which is inside the signed content and
-- therefore cannot be forged or replayed onto another body.
CREATE TABLE private.quo_webhook_deliveries (
  webhook_id text PRIMARY KEY CHECK (length(webhook_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) <= 80),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quo_webhook_deliveries_received ON private.quo_webhook_deliveries(received_at DESC);
ALTER TABLE private.quo_webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.quo_webhook_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.quo_webhook_deliveries TO service_role;
CREATE POLICY "Only backend workers record deliveries" ON private.quo_webhook_deliveries
  TO service_role USING (true) WITH CHECK (true);

-- ── Recheck queue: what an event says is worth looking at ───────────────────
-- Only lead ids and a reason code. No message content, ever.
CREATE TABLE private.lead_ai_recheck_queue (
  lead_id uuid PRIMARY KEY REFERENCES public.qualified_leads(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(reason) <= 80),
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_ai_recheck_queue_requested ON private.lead_ai_recheck_queue(requested_at);
ALTER TABLE private.lead_ai_recheck_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.lead_ai_recheck_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.lead_ai_recheck_queue TO service_role;
CREATE POLICY "Only backend workers queue rechecks" ON private.lead_ai_recheck_queue
  TO service_role USING (true) WITH CHECK (true);

-- ── Persist last_message_at on completion ───────────────────────────────────
-- Identical to the fenced version in 20261021113225 apart from the new column;
-- replaced wholesale because the fencing and canonicalisation must not drift.
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
  p_result := jsonb_set(p_result,'{status}',coalesce(to_jsonb(
    public.canonical_cs_status((p_result->>'status')::public.cs_status)), 'null'::jsonb));
  IF p_result->>'status'='need_follow_up' THEN
    p_result := p_result || jsonb_build_object('state','review','status',NULL,'confidence',NULL,
      'reasonCode','manual_follow_up','evidenceIds','[]'::jsonb,'historyHash',NULL);
  END IF;
  INSERT INTO public.lead_ai_status(lead_id,run_id,source_key,state,ai_status,confidence,reason_code,
    evidence_ids,message_count,history_hash,model,policy_version,last_message_at)
  VALUES(r.lead_id,r.id,r.source_key,p_result->>'state',(p_result->>'status')::public.cs_status,
    (p_result->>'confidence')::double precision,p_result->>'reasonCode',
    ARRAY(SELECT jsonb_array_elements_text(p_result->'evidenceIds')),
    (p_result->>'messageCount')::integer,p_result->>'historyHash',p_result->>'model',p_result->>'policyVersion',
    CASE WHEN p_result->>'lastMessageAt' IS NULL THEN NULL
         ELSE (p_result->>'lastMessageAt')::timestamptz END)
  ON CONFLICT(lead_id) DO UPDATE SET run_id=EXCLUDED.run_id,source_key=EXCLUDED.source_key,
    state=EXCLUDED.state,ai_status=EXCLUDED.ai_status,confidence=EXCLUDED.confidence,
    reason_code=EXCLUDED.reason_code,evidence_ids=EXCLUDED.evidence_ids,message_count=EXCLUDED.message_count,
    history_hash=EXCLUDED.history_hash,model=EXCLUDED.model,policy_version=EXCLUDED.policy_version,
    last_message_at=EXCLUDED.last_message_at,analyzed_at=now();
  UPDATE public.lead_ai_status_runs SET outcome=p_result->>'state',result=p_result,finished_at=now(),
    work_done=work_total,last_progress_at=now() WHERE id=p_run_id;
  DELETE FROM private.quo_ai_sync_jobs WHERE run_id=p_run_id;
  RETURN true;
END $$;

-- ── Accept one verified webhook delivery ────────────────────────────────────
-- Signature verification happens in the edge function; by the time this runs
-- the delivery is known to be from Quo. This does the cheap part only: dedupe,
-- resolve the number to leads, park them. No Quo or model calls, so a burst of
-- events costs a burst of index lookups rather than a burst of history syncs.
CREATE FUNCTION public.accept_quo_webhook_event(
  p_webhook_id text, p_event_type text, p_phone text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE normalized text; v_reason text; inserted integer; matched integer := 0;
BEGIN
  IF p_webhook_id IS NULL OR length(p_webhook_id) NOT BETWEEN 1 AND 200
    OR p_event_type IS NULL OR length(p_event_type) > 80 THEN
    RAISE EXCEPTION 'Invalid webhook event';
  END IF;
  -- Idempotency before anything else: a retry must not re-queue work.
  INSERT INTO private.quo_webhook_deliveries(webhook_id, event_type)
    VALUES (p_webhook_id, p_event_type) ON CONFLICT (webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true, 'matched', 0); END IF;

  normalized := public.lead_ai_phone(p_phone);
  IF normalized IS NULL THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'unparseable_phone');
  END IF;
  v_reason := CASE p_event_type
    WHEN 'message.received' THEN 'customer_replied'
    WHEN 'message.undelivered' THEN 'delivery_failed'
    ELSE 'delivery_confirmed' END;
  -- A number on more than one lead queues both. The worker already files that
  -- case as phone_shared_between_leads, so this cannot silently pick a lead;
  -- dropping the event instead would lose it entirely.
  -- Manual follow-up leads are excluded here exactly as they are from the
  -- batch enqueue, so an event cannot drag one back into comparison.
  WITH touched AS (
    INSERT INTO private.lead_ai_recheck_queue AS rq (lead_id, reason)
    SELECT q.id, v_reason FROM public.qualified_leads q
     WHERE q.cs_status <> 'need_follow_up'
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR EXISTS (SELECT 1 FROM unnest(q.extra_numbers) n
                    WHERE public.lead_ai_phone(n) = normalized))
    ON CONFLICT (lead_id) DO UPDATE
      SET reason = excluded.reason, requested_at = now()
    RETURNING rq.lead_id
  ) SELECT count(*)::integer INTO matched FROM touched;
  RETURN jsonb_build_object('duplicate', false, 'matched', matched, 'reason', v_reason);
END $$;

-- ── The sweep: enqueue only what has a reason to be looked at ───────────────
CREATE FUNCTION public.enqueue_quo_ai_due(p_inbox_ids text[], p_limit integer DEFAULT 5)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE picked record; run uuid; remaining integer; queued integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021,61);
  IF p_inbox_ids IS NULL OR cardinality(p_inbox_ids) NOT BETWEEN 1 AND 100
    OR EXISTS (SELECT 1 FROM unnest(p_inbox_ids) id WHERE id IS NULL OR id !~ '^PN[a-zA-Z0-9_-]+$') THEN
    RAISE EXCEPTION 'Invalid inbox scope';
  END IF;
  PERFORM public.expire_quo_ai_jobs();
  -- Same per-minute ceiling as the manual batch, but stopping at 400 of the
  -- 500 daily runs: an unattended sweep must never starve the button it was
  -- built to replace, so the last fifth of the budget stays for a person.
  SELECT least(greatest(coalesce(p_limit,5),1), 5,
    5 - count(*) FILTER (WHERE started_at > now() - interval '1 minute'),
    400 - count(*))::integer
    INTO remaining FROM public.lead_ai_status_runs WHERE started_at > now() - interval '1 day';
  IF remaining <= 0 THEN RETURN 0; END IF;
  FOR picked IN
    WITH candidate AS (
      SELECT q.id, q.cs_status, public.lead_ai_source_key(q) AS source_key,
        CASE
          -- An event beats everything: something actually changed.
          WHEN rq.lead_id IS NOT NULL THEN 0
          WHEN a.lead_id IS NULL THEN 1
          -- Delivery had not confirmed yet when it was looked at. These resolve
          -- within seconds in reality but keep a lead parked in "review".
          WHEN a.state = 'review' AND a.reason_code = 'delivery_not_confirmed'
            AND a.analyzed_at < now() - interval '10 minutes' THEN 2
          -- The lead itself was edited, so the old comparison no longer applies.
          WHEN a.source_key <> public.lead_ai_source_key(q) THEN 3
          -- Past 24h and still delivery_confirmed means the SQL flip could not
          -- apply (no recent webhook, so silence is not evidence): re-read it.
          WHEN a.reason_code = 'delivery_confirmed' AND a.last_message_at IS NOT NULL
            AND a.last_message_at < now() - interval '24 hours' THEN 4
          ELSE NULL
        END AS priority,
        CASE
          WHEN rq.lead_id IS NOT NULL THEN extract(epoch FROM rq.requested_at)
          -- Newest unseen lead first; the back catalogue trickles behind it.
          WHEN a.lead_id IS NULL THEN -extract(epoch FROM q.assigned_at)
          ELSE extract(epoch FROM a.analyzed_at)
        END AS sort_key
      FROM public.qualified_leads q
      LEFT JOIN public.lead_ai_status a ON a.lead_id = q.id
      LEFT JOIN private.lead_ai_recheck_queue rq ON rq.lead_id = q.id
      LEFT JOIN LATERAL (SELECT r.started_at FROM public.lead_ai_status_runs r
        WHERE r.lead_id = q.id ORDER BY r.started_at DESC LIMIT 1) last_run ON true
      WHERE q.cs_status <> 'need_follow_up'
        AND (last_run.started_at IS NULL OR last_run.started_at < now() - interval '15 minutes')
        AND NOT EXISTS (SELECT 1 FROM public.lead_ai_status_runs r
          WHERE r.lead_id = q.id AND r.outcome = 'running')
    )
    SELECT * FROM candidate WHERE priority IS NOT NULL
    ORDER BY priority, sort_key, id
    LIMIT remaining
  LOOP
    INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,manual_status,requested_via,work_total)
      VALUES(picked.id,NULL,picked.source_key,picked.cs_status,'management',cardinality(p_inbox_ids))
      RETURNING id INTO run;
    INSERT INTO private.quo_ai_sync_jobs(run_id,inbox_ids) VALUES(run,p_inbox_ids);
    -- Claimed, so the event is spent. An event arriving during the run is a
    -- fresh row and will be picked up again on the next sweep.
    DELETE FROM private.lead_ai_recheck_queue WHERE lead_id = picked.id;
    queued := queued+1;
  END LOOP;
  RETURN queued;
END $$;

-- ── The 24-hour rule, without touching Quo ──────────────────────────────────
CREATE FUNCTION public.flip_quo_ai_no_reply() RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE flipped integer := 0;
BEGIN
  -- Treating silence as "no reply" is only sound while inbound replies are
  -- actually arriving. If no delivery has been seen for a day the webhook is
  -- down or was never attached, silence proves nothing, and these leads are
  -- left to the sweep's priority 4 to re-read from Quo instead.
  IF NOT EXISTS (SELECT 1 FROM private.quo_webhook_deliveries
                 WHERE received_at > now() - interval '24 hours') THEN
    RETURN 0;
  END IF;
  -- Only rows whose verdict was "delivered, nothing since": a transport rule
  -- the model was never consulted about, so applying the next step of the same
  -- rule needs no provider. source_key is re-checked so an edited lead is not
  -- advanced on a stale comparison, and a queued recheck wins over the clock.
  UPDATE public.lead_ai_status a
     SET ai_status = 'cx_didnt_replied'::public.cs_status,
         reason_code = 'no_reply_after_24h',
         analyzed_at = now()
    FROM public.qualified_leads q
   WHERE q.id = a.lead_id
     AND a.state = 'classified'
     AND a.ai_status = 'converted'::public.cs_status
     AND a.reason_code = 'delivery_confirmed'
     AND a.last_message_at IS NOT NULL
     AND a.last_message_at < now() - interval '24 hours'
     AND a.source_key = public.lead_ai_source_key(q)
     AND NOT EXISTS (SELECT 1 FROM private.lead_ai_recheck_queue rq WHERE rq.lead_id = a.lead_id);
  GET DIAGNOSTICS flipped = ROW_COUNT;
  RETURN flipped;
END $$;

-- ── Bounded retention for both queues ───────────────────────────────────────
CREATE FUNCTION public.purge_quo_webhook_state() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- Well past Quo's retry window, so a late retry is still deduplicated.
  DELETE FROM private.quo_webhook_deliveries WHERE received_at < now() - interval '3 days';
  -- A recheck nothing has drained in a week is not going to inform anything.
  DELETE FROM private.lead_ai_recheck_queue WHERE requested_at < now() - interval '7 days';
END $$;

REVOKE ALL ON FUNCTION public.accept_quo_webhook_event(text,text,text),
  public.enqueue_quo_ai_due(text[],integer), public.flip_quo_ai_no_reply(),
  public.purge_quo_webhook_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quo_webhook_event(text,text,text),
  public.enqueue_quo_ai_due(text[],integer), public.flip_quo_ai_no_reply(),
  public.purge_quo_webhook_state() TO service_role;

-- ── Schedules ───────────────────────────────────────────────────────────────
-- Reuses the Vault-held worker credentials; never embeds a key in cron text.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
    AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
    -- Only when the job table is empty, so the sweep tops up a drained queue
    -- instead of piling work on a backlog the single worker is still chewing.
    PERFORM cron.schedule('quo-ai-autoqueue','*/5 * * * *',$cron$
      SELECT net.http_post(
        url:=(SELECT regexp_replace(decrypted_secret,'/crisp-auto-greet/?$','/quo-ai-status')
          FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_url'),
        headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_key')),
        body:='{"action":"enqueue"}'::jsonb,timeout_milliseconds:=20000)
      WHERE NOT EXISTS(SELECT 1 FROM private.quo_ai_sync_jobs)
        AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_url'
          AND decrypted_secret LIKE '%/functions/v1/crisp-auto-greet')
        AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='crisp_auto_greet_key');
    $cron$);
    PERFORM cron.schedule('quo-ai-no-reply','11,26,41,56 * * * *','SELECT public.flip_quo_ai_no_reply()');
    PERFORM cron.schedule('quo-webhook-state-cleanup','41 3 * * *','SELECT public.purge_quo_webhook_state()');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
