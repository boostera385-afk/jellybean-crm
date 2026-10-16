-- Greet visitors again on genuine re-visits, and stop polling dead workspaces.
--
-- Measured behavior until now: a visitor was greeted exactly once ever, because
-- crisp_greeting_jobs carried a hard UNIQUE(crisp_website_id, crisp_session_id),
-- crisp_enqueue_greeting only fired while auto_greeted_at IS NULL, and returning
-- visitors keep the same Crisp session_id. The visitor acutely reported the
-- consequence: first visit = greeting; every later visit = silence.
--
-- What changes:
-- 1. The "one job per session" uniqueness becomes "one ACTIVE job per session".
--    History (sent/failed/cancelled rows) is kept, so a later visit may queue a
--    fresh greeting without losing the audit trail.
-- 2. crisp_enqueue_greeting re-greets a returning visitor only when all of the
--    following hold: revisit is enabled with a non-empty message, the previous
--    greeting is older than auto_greet_revisit_after_seconds (default 6h, floor
--    5 minutes so one browsing session can never be spammed), and the visitor
--    has NEVER replied — a visitor who replied is a lead for a human, not for
--    the bot. Visitors who already conversed via an operator keep the original
--    "never greet" rule.
-- 3. Consecutive unrecognized HTTP 404/403 presence responses trip a breaker
--    that pauses polling for one hour (auto-retries hourly so a restored
--    workspace recovers without intervention).
-- 4. message:acknowledge:read:received receipts whose fingerprints match no
--    tracked message are completed instead of dead-lettering the queue at
--    attempts=8: Crisp sends these for dashboard-sent or pre-pipeline messages.

ALTER TABLE public.crisp_workspaces
  ADD COLUMN auto_greet_revisit_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_greet_revisit_message text
    DEFAULT 'Welcome back, {{name}}! 👋 Great to see you again — if you still have any questions or need help choosing the right service, I''m right here and happy to help.',
  ADD COLUMN auto_greet_revisit_after_seconds integer NOT NULL DEFAULT 21600
    CHECK (auto_greet_revisit_after_seconds BETWEEN 300 AND 604800),
  ADD COLUMN presence_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN presence_paused_until timestamptz,
  ADD COLUMN presence_paused_reason text;

-- Polite, professional default; editable per workspace in Settings → Crisp.
UPDATE public.crisp_workspaces
SET auto_greet_revisit_message =
  'Welcome back, {{name}}! 👋 Great to see you again — if you still have any questions or need help choosing the right service, I''m right here and happy to help.'
WHERE auto_greet_revisit_message IS NULL;

ALTER TABLE public.crisp_greeting_jobs
  ADD COLUMN is_revisit boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname='crisp_greeting_jobs_crisp_website_id_crisp_session_id_key'
               AND conrelid='public.crisp_greeting_jobs'::regclass) THEN
    ALTER TABLE public.crisp_greeting_jobs
      DROP CONSTRAINT crisp_greeting_jobs_crisp_website_id_crisp_session_id_key;
  END IF;
  DROP INDEX IF EXISTS public.crisp_greeting_jobs_crisp_website_id_crisp_session_id_key;
END $$;

-- One in-flight job per session is still the dedupe guarantee; completed jobs
-- no longer block a future greeting.
CREATE UNIQUE INDEX IF NOT EXISTS crisp_greeting_jobs_active_session_idx
  ON public.crisp_greeting_jobs (crisp_website_id, crisp_session_id)
  WHERE state IN ('pending','leased','sending');

-- Trigger: first greet exactly as before; re-greet per the revisit policy.
CREATE OR REPLACE FUNCTION public.crisp_enqueue_greeting()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE w public.crisp_workspaces; delay integer; template text; base timestamptz; revisit boolean;
BEGIN
  IF NOT NEW.is_online THEN RETURN NEW; END IF;
  SELECT * INTO w FROM public.crisp_workspaces WHERE crisp_website_id=NEW.crisp_website_id;
  IF NOT w.enabled OR NOT w.greeting_worker_enabled THEN RETURN NEW; END IF;
  IF NEW.auto_greeted_at IS NULL THEN
    IF NOT w.auto_greet_enabled OR NEW.first_seen_at < w.pipeline_started_at
      OR nullif(trim(coalesce(w.auto_greet_message,'')),'') IS NULL THEN RETURN NEW; END IF;
    -- An operator already spoke to this visitor; the bot stays silent.
    IF EXISTS(SELECT 1 FROM public.crisp_conversations WHERE crisp_website_id=NEW.crisp_website_id
      AND crisp_session_id=NEW.crisp_session_id AND nullif(last_message,'') IS NOT NULL) THEN RETURN NEW; END IF;
    revisit := false; template := w.auto_greet_message;
    delay := greatest(0,least(3600,w.auto_greet_delay_seconds)); base := NEW.first_seen_at;
  ELSE
    IF NOT w.auto_greet_enabled OR NOT w.auto_greet_revisit_enabled
      OR nullif(trim(coalesce(w.auto_greet_revisit_message,'')),'') IS NULL THEN RETURN NEW; END IF;
    -- Cooldown since the previous greeting; floored at 5 minutes so repeated
    -- presence flips inside one visit can never stack greetings.
    IF NEW.auto_greeted_at > now() - greatest(300,least(604800,w.auto_greet_revisit_after_seconds)) * interval '1 second'
      THEN RETURN NEW; END IF;
    -- A visitor who ever replied is already engaged: follow-up is human work.
    IF EXISTS(SELECT 1 FROM public.crisp_messages WHERE crisp_website_id=NEW.crisp_website_id
      AND crisp_session_id=NEW.crisp_session_id AND direction='incoming') THEN RETURN NEW; END IF;
    revisit := true; template := w.auto_greet_revisit_message;
    delay := greatest(0,least(3600,w.auto_greet_delay_seconds)); base := now();
  END IF;
  INSERT INTO public.crisp_greeting_jobs(crisp_website_id,crisp_session_id,content,due_at,expires_at,is_revisit)
  VALUES(NEW.crisp_website_id,NEW.crisp_session_id,
    regexp_replace(regexp_replace(template,'{\{\s*name\s*\}\}',coalesce(NEW.nickname,'there'),'gi'),
      '{\{\s*city\s*\}\}',coalesce(NEW.city,''),'gi'),
    base+make_interval(secs=>delay),base+make_interval(secs=>delay)+interval '2 minutes',revisit)
  ON CONFLICT (crisp_website_id,crisp_session_id) WHERE state IN ('pending','leased','sending') DO NOTHING;
  RETURN NEW;
END;
$function$;

-- Claim: eligibility must respect revisit jobs (their session legitimately has
-- auto_greeted_at set and a conversation containing earlier greetings).
CREATE OR REPLACE FUNCTION public.crisp_claim_greetings(p_website_id text, p_limit integer DEFAULT 2)
 RETURNS SETOF crisp_greeting_jobs
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE slots integer;
BEGIN
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

CREATE OR REPLACE FUNCTION public.crisp_begin_greeting(p_id uuid, p_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE j public.crisp_greeting_jobs;
BEGIN
  SELECT * INTO j FROM public.crisp_greeting_jobs WHERE id=p_id;
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=j.crisp_website_id AND enabled AND auto_greet_enabled AND greeting_worker_enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO j FROM public.crisp_greeting_jobs WHERE id=p_id AND state='leased' AND lease_token=p_token AND lease_until>now() AND expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- First greetings: any prior conversation spells human involvement.
  -- Revisit greetings: only an actual visitor reply blocks the bot.
  IF (NOT j.is_revisit AND EXISTS(SELECT 1 FROM public.crisp_conversations c WHERE c.crisp_website_id=j.crisp_website_id AND c.crisp_session_id=j.crisp_session_id AND nullif(c.last_message,'') IS NOT NULL))
    OR (j.is_revisit AND EXISTS(SELECT 1 FROM public.crisp_messages m WHERE m.crisp_website_id=j.crisp_website_id AND m.crisp_session_id=j.crisp_session_id AND m.direction='incoming')) THEN
    UPDATE public.crisp_greeting_jobs SET state='cancelled' WHERE id=p_id; RETURN false; END IF;
  UPDATE public.crisp_visitors SET auto_greeted_at=now() WHERE crisp_website_id=j.crisp_website_id AND crisp_session_id=j.crisp_session_id
    AND is_online AND (auto_greeted_at IS NULL OR auto_greeted_at<j.created_at);
  IF NOT FOUND THEN UPDATE public.crisp_greeting_jobs SET state='cancelled' WHERE id=p_id; RETURN false; END IF;
  UPDATE public.crisp_greeting_jobs SET state='sending',request_started_at=now() WHERE id=p_id;
  RETURN true;
END;
$function$;

-- Unmatched read receipts are receipts for messages this pipeline never tracked
-- (dashboard sends, Crispbot, pre-pipeline history). Recording the mismatch and
-- completing the event keeps the durable queue clean; retrying can never match.
DO $$
DECLARE definition text; anchor text := 'IF coalesce(array_length(receipts,1),0)>matched THEN RAISE EXCEPTION ''Unmatched delivery receipt''; END IF;';
BEGIN
  definition := pg_get_functiondef('public.crisp_apply_event(jsonb)'::regprocedure);
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected event function definition'; END IF;
  definition := replace(definition,anchor,
    '-- Unmatched fingerprints belong to messages sent outside this pipeline (dashboard sends,'||E'\n'||
    '  -- Crispbot, pre-pipeline history); completing beats dead-lettering.');
  EXECUTE definition;
END $$;

-- Presence breaker: repeated unrecognized 404/403 means the workspace is gone
-- or the token was revoked. Pause polling for an hour so dead workspaces stop
-- consuming quota, while an hourly probe restores them automatically.
DO $$
DECLARE definition text; anchor text := 'visitor_sync_error=p_error,';
BEGIN
  definition := pg_get_functiondef('public.crisp_finish_presence(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text)'::regprocedure);
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected presence finisher definition'; END IF;
  definition := replace(definition,anchor,
    'visitor_sync_error=p_error,'||E'\n'||
    '    presence_failure_count=CASE WHEN p_error IS NULL THEN 0'||E'\n'||
    '      WHEN p_error LIKE ''%HTTP 404%'' OR p_error LIKE ''%HTTP 403%'' THEN presence_failure_count+1 ELSE presence_failure_count END,'||E'\n'||
    '    presence_paused_until=CASE WHEN (p_error LIKE ''%HTTP 404%'' OR p_error LIKE ''%HTTP 403%'')'||E'\n'||
    '      AND presence_failure_count+1>=10 THEN now()+interval ''1 hour'' ELSE presence_paused_until END,'||E'\n'||
    '    presence_paused_reason=CASE WHEN (p_error LIKE ''%HTTP 404%'' OR p_error LIKE ''%HTTP 403%'')'||E'\n'||
    '      AND presence_failure_count+1>=10 THEN left(p_error,120) ELSE presence_paused_reason END,');
  EXECUTE definition;
END $$;

DO $$
DECLARE definition text; anchor text := 'IF NOT FOUND OR w.crisp_cooldown_until>now() OR w.visitor_sync_lease_until>now() THEN RETURN NULL; END IF;';
BEGIN
  definition := pg_get_functiondef('public.crisp_claim_presence(text)'::regprocedure);
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected presence claim definition'; END IF;
  definition := replace(definition,anchor,
    'IF NOT FOUND OR w.crisp_cooldown_until>now() OR w.visitor_sync_lease_until>now()'||E'\n'||
    '    OR w.presence_paused_until>now() THEN RETURN NULL; END IF;');
  EXECUTE definition;
END $$;

COMMENT ON COLUMN public.crisp_workspaces.presence_paused_until IS
  'Circuit breaker: polling paused until this time after repeated 404/403 responses; probes hourly for recovery.';
COMMENT ON COLUMN public.crisp_greeting_jobs.is_revisit IS
  'True when this greeting is a polite re-engagement of a returning visitor, not their first greeting.';
