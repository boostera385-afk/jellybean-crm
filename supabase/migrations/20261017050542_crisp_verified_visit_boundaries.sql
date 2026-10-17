-- Version matches the recorded Supabase MCP migration.
-- Cooldown expiry is not a new visit. Only verified offline -> online transitions
-- advance this marker; anonymous WordPress hints never touch visitor rows.
ALTER TABLE public.crisp_visitors ADD COLUMN visit_started_at timestamptz;

DO $$
DECLARE definition text; anchor text;
BEGIN
  definition:=pg_get_functiondef('public.crisp_enqueue_greeting()'::regprocedure);
  anchor:='  ELSE
    IF NOT w.auto_greet_enabled OR NOT w.auto_greet_revisit_enabled';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected greeting trigger'; END IF;
  definition:=replace(definition,anchor,'  ELSE
    IF NEW.visit_started_at IS NULL OR NEW.visit_started_at<=NEW.auto_greeted_at THEN RETURN NEW; END IF;
    IF NOT w.auto_greet_enabled OR NOT w.auto_greet_revisit_enabled');
  anchor:='base := NEW.first_seen_at;';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected first greeting base'; END IF;
  -- A never-greeted legacy visitor must not get an already-expired job.
  definition:=replace(definition,anchor,'base := now();');
  EXECUTE definition;
END $$;

-- Backfill conservatively: existing online sessions are already in their visit.
-- This transaction already holds the ALTER TABLE lock. Disable only the enqueue
-- trigger during backfill so migration itself cannot schedule any messages.
ALTER TABLE public.crisp_visitors DISABLE TRIGGER crisp_enqueue_greeting;
UPDATE public.crisp_visitors SET visit_started_at=coalesce(auto_greeted_at,first_seen_at,now());
ALTER TABLE public.crisp_visitors ENABLE TRIGGER crisp_enqueue_greeting;
ALTER TABLE public.crisp_visitors ALTER COLUMN visit_started_at SET DEFAULT now(),
  ALTER COLUMN visit_started_at SET NOT NULL;

CREATE FUNCTION public.crisp_track_visit_boundary() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.visit_started_at:=coalesce(NEW.presence_observed_at,NEW.first_seen_at,now());
  ELSE
    NEW.visit_started_at:=OLD.visit_started_at;
    -- Debounce brief presence flaps. A verified absence must last >=2 minutes.
    -- Use observation times, not updates to names, messages or other metadata.
    IF NEW.is_online AND NOT OLD.is_online AND NEW.presence_observed_at IS NOT NULL
      AND OLD.presence_observed_at IS NOT NULL
      AND NEW.presence_observed_at>=OLD.presence_observed_at+interval '2 minutes' THEN
      NEW.visit_started_at:=greatest(OLD.visit_started_at,NEW.presence_observed_at);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crisp_track_visit_boundary BEFORE INSERT OR UPDATE ON public.crisp_visitors
FOR EACH ROW EXECUTE FUNCTION public.crisp_track_visit_boundary();
REVOKE ALL ON FUNCTION public.crisp_track_visit_boundary() FROM PUBLIC,anon,authenticated;

DO $$
DECLARE definition text; anchor text;
BEGIN
  definition:=pg_get_functiondef('public.crisp_begin_greeting(uuid,uuid)'::regprocedure);
  anchor:='AND is_online AND (auto_greeted_at IS NULL OR auto_greeted_at<j.created_at);';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected greeting eligibility'; END IF;
  definition:=replace(definition,anchor,'AND is_online AND (auto_greeted_at IS NULL OR auto_greeted_at<j.created_at)
    AND (NOT j.is_revisit OR (visit_started_at>auto_greeted_at AND visit_started_at<=j.created_at));');
  EXECUTE definition;
END $$;

-- Recall only unsent revisit jobs that have no new visit evidence. Never alter
-- sent/sending/uncertain jobs: an external request cannot safely be recalled.
UPDATE public.crisp_greeting_jobs j SET state='cancelled',last_error='No verified new visit'
FROM public.crisp_visitors v WHERE j.crisp_website_id=v.crisp_website_id
  AND j.crisp_session_id=v.crisp_session_id AND j.is_revisit AND j.state IN ('pending','leased')
  AND v.visit_started_at<=v.auto_greeted_at;
