-- Save every AI first-reply draft beside the version the agent actually kept,
-- so the composer's review step learns from the team's corrections.
--
-- cs-compose-lead inserts one row per successful draft (draft text, names
-- masked). When an agent then edits that lead's marketing_notes, the trigger
-- below stores the edited text, names masked, as `final`. A row whose final is
-- set is a correction; the Edge Function shows the most relevant ones to the
-- review model as examples (cs-compose-examples.ts filters out anything that
-- no longer has the message form or looks like contact details).
--
-- Set status = 'rejected' on a row to stop it being used as an example.
-- Only the server role can read or write: no browser access.

CREATE TABLE public.cs_compose_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid UNIQUE REFERENCES public.cs_compose_runs(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.qualified_leads(id) ON DELETE CASCADE,
  service text,
  draft text NOT NULL CHECK (length(draft) <= 1000),
  final text CHECK (length(final) <= 1000),
  status text NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  corrected_at timestamptz
);
CREATE INDEX cs_compose_corrections_lead_idx
  ON public.cs_compose_corrections (lead_id, created_at DESC);
CREATE INDEX cs_compose_corrections_examples_idx
  ON public.cs_compose_corrections (corrected_at DESC)
  WHERE final IS NOT NULL AND status <> 'rejected';
ALTER TABLE public.cs_compose_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cs_compose_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cs_compose_corrections TO service_role;

CREATE FUNCTION public.cs_capture_compose_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_first text;
  v_text text;
BEGIN
  IF NEW.marketing_notes IS NULL OR btrim(NEW.marketing_notes) = '' THEN
    RETURN NEW;
  END IF;
  v_text := left(btrim(NEW.marketing_notes), 1000);
  -- Mask the customer's first name and the sender's, the same way the Edge
  -- Function masks the draft, so an untouched draft compares equal.
  v_first := split_part(btrim(coalesce(NEW.customer_name, '')), ' ', 1);
  IF v_first <> '' THEN
    v_text := regexp_replace(
      v_text,
      '\m' || regexp_replace(v_first, '([^[:alnum:]])', '\\\1', 'g') || '\M',
      '{name}',
      'gi'
    );
  END IF;
  v_text := regexp_replace(v_text, '(this is )[[:alpha:]''’-]+', '\1{agent}', 'i');

  UPDATE public.cs_compose_corrections c
  SET final = CASE WHEN v_text = c.draft THEN NULL ELSE v_text END,
      corrected_at = CASE WHEN v_text = c.draft THEN NULL ELSE now() END
  WHERE c.id = (
    SELECT id FROM public.cs_compose_corrections
    WHERE lead_id = NEW.id AND created_at > now() - interval '14 days'
    ORDER BY created_at DESC
    LIMIT 1
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cs_capture_compose_correction() FROM PUBLIC, anon, authenticated;

-- Fires only when marketing_notes actually changes, so ordinary lead updates
-- (status, assignment, timestamps) never run it.
CREATE TRIGGER trg_qualified_leads_capture_compose_correction
AFTER UPDATE OF marketing_notes ON public.qualified_leads
FOR EACH ROW
WHEN (OLD.marketing_notes IS DISTINCT FROM NEW.marketing_notes)
EXECUTE FUNCTION public.cs_capture_compose_correction();
