-- crisp_claim_greetings: return before any locking when there is nothing to do.
--
-- The 5s crisp-auto-greet worker calls this twice per enabled workspace per
-- tick: ~444k calls/day for ~640 greetings/day. Every call took a global
-- advisory lock (serialising all workspaces and overlapping invocations),
-- row-locked the workspace (a WAL write) and ran three UPDATEs, even though
-- 99.9% of calls had no job to look at.
--
-- Fast exit: if the workspace has no job in pending/leased/sending, every
-- statement below would match zero rows, so returning early is exactly
-- equivalent. The check uses crisp_greetings_pending_idx (partial on those
-- states). Claim timing is unchanged: a job is still claimed on the first tick
-- after it becomes due. Body below the fast exit is the live definition as of
-- 2026-11-11, unchanged.

CREATE OR REPLACE FUNCTION public.crisp_claim_greetings(p_website_id text, p_limit integer DEFAULT 2)
 RETURNS SETOF crisp_greeting_jobs
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE slots integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.crisp_greeting_jobs
    WHERE crisp_website_id=p_website_id AND state IN ('pending','leased','sending')
  ) THEN RETURN; END IF;
  -- Bound external-send concurrency across overlapping Edge invocations too.
  PERFORM pg_advisory_xact_lock(hashtextextended('crisp-greeting-claims',0));
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND enabled AND greeting_worker_enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.crisp_greeting_jobs SET state='uncertain',last_error='Worker stopped after send began'
    WHERE crisp_website_id=p_website_id AND state='sending' AND lease_until<=now();
  UPDATE public.crisp_greeting_jobs SET state='pending',lease_token=NULL,lease_until=NULL
    WHERE crisp_website_id=p_website_id AND state='leased' AND lease_until<=now();
  UPDATE public.crisp_greeting_jobs j SET state='cancelled',last_error='Expired or no longer eligible'
    WHERE j.crisp_website_id=p_website_id AND j.state='pending' AND (j.expires_at<=now() OR j.attempts>=5 OR NOT EXISTS(
      SELECT 1 FROM public.crisp_visitors v JOIN public.crisp_workspaces w USING(crisp_website_id)
      WHERE v.crisp_website_id=j.crisp_website_id AND v.crisp_session_id=j.crisp_session_id AND v.is_online
        AND (v.auto_greeted_at IS NULL OR v.auto_greeted_at<=j.created_at) AND w.auto_greet_enabled AND w.enabled)
      OR (NOT j.is_revisit AND EXISTS(SELECT 1 FROM public.crisp_conversations c WHERE c.crisp_website_id=j.crisp_website_id AND c.crisp_session_id=j.crisp_session_id AND nullif(c.last_message,'') IS NOT NULL))
      OR (j.is_revisit AND EXISTS(SELECT 1 FROM public.crisp_messages m WHERE m.crisp_website_id=j.crisp_website_id AND m.crisp_session_id=j.crisp_session_id AND m.direction='incoming')));
  SELECT least(2-count(*) FILTER(WHERE crisp_website_id=p_website_id),6-count(*))::integer INTO slots
    FROM public.crisp_greeting_jobs WHERE state IN ('leased','sending') AND lease_until>now();
  IF slots<=0 THEN RETURN; END IF;
  RETURN QUERY UPDATE public.crisp_greeting_jobs SET state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '30 seconds',attempts=attempts+1
    WHERE id IN(SELECT id FROM public.crisp_greeting_jobs WHERE crisp_website_id=p_website_id AND state='pending'
      AND due_at<=now() ORDER BY due_at LIMIT greatest(1,least(slots,p_limit)) FOR UPDATE SKIP LOCKED) RETURNING *;
END;
$function$;
