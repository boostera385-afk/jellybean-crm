-- Record when CS changes a lead's delivery method to "called".
-- Existing called leads use the latest matching activity-log time when
-- available, falling back to the lead's last update time.

ALTER TABLE public.qualified_leads
    ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ;

UPDATE public.qualified_leads AS lead
SET called_at = COALESCE(
    (
        SELECT MAX(log.created_at)
        FROM public.activity_logs AS log
        WHERE log.entity_type = 'qualified_lead'
          AND log.entity_id = lead.id::text
          AND log.action = 'cs.contact_method_changed'
          AND log.metadata->>'contact_method' = 'called'
    ),
    lead.updated_at
)
WHERE lead.contact_method = 'called'
  AND lead.called_at IS NULL;

CREATE OR REPLACE FUNCTION public.sync_qualified_lead_called_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.contact_method = 'called' THEN
        IF TG_OP = 'INSERT'
           OR OLD.contact_method IS DISTINCT FROM 'called'
           OR NEW.called_at IS NULL THEN
            NEW.called_at := COALESCE(NEW.called_at, NOW());
        END IF;
    ELSE
        NEW.called_at := NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_qualified_lead_called_at
    ON public.qualified_leads;

CREATE TRIGGER sync_qualified_lead_called_at
BEFORE INSERT OR UPDATE OF contact_method, called_at
ON public.qualified_leads
FOR EACH ROW
EXECUTE FUNCTION public.sync_qualified_lead_called_at();

-- The CS follow-up view filters by status and missing call time, then sorts by
-- assignment time. A partial index keeps that report fast without indexing
-- rows that have already been called.
CREATE INDEX IF NOT EXISTS idx_qualified_leads_uncalled_status_assigned
    ON public.qualified_leads (cs_status, assigned_at DESC)
    WHERE called_at IS NULL;
