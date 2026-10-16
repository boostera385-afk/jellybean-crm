-- Let returning visitors actually get greeted.
--
-- Measured production evidence (2026-10-16, 24h): 370 greetings sent, ALL
-- first-greets, zero revisit jobs. Two causes:
-- 1. The cutover protection `first_seen_at < pipeline_started_at` still lives
--    in the first-greet path. Visitors whose row predates Oct 14 (e.g., the
--    operator's own test browser from Oct 12) are refused a first greeting AND
--    never reach the revisit path, because their auto_greeted_at stays NULL.
--    Three such sessions were observed online at audit time. The backlog
--    risk this gate guarded against (mass-greeting on deploy day) is gone;
--    greeting a returning past visitor on their genuine return is the point.
-- 2. The 6h revisit cooldown default suppressed same-session re-visits within
--    the hour. Lowered to 30 minutes; operators can tune it in Settings
--    (5-minute floor still prevents greeting the same active visit twice).

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
    IF NOT w.auto_greet_enabled OR nullif(trim(coalesce(w.auto_greet_message,'')),'') IS NULL
      THEN RETURN NEW; END IF;
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

ALTER TABLE public.crisp_workspaces
  ALTER COLUMN auto_greet_revisit_after_seconds SET DEFAULT 1800;

UPDATE public.crisp_workspaces
SET auto_greet_revisit_after_seconds = 1800
WHERE auto_greet_revisit_after_seconds = 21600;
