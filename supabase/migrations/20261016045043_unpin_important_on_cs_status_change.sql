-- A pinned important lead is a "handle this first" marker for a brand new lead.
-- Filename matches the version assigned by Supabase MCP on production.
-- Once CS moves it out of 'new' the pin has done its job and must clear.
--
-- The UI already hid the pin badge behind `cs_status === 'new'`
-- (app.cs-leads.tsx), but the column itself never cleared. Stale pins therefore
-- still drove the things that do NOT carry that guard: the server-side
-- `.order("pinned_important", desc)` on the CS list, and the pinned handling in
-- the Google Sheets sync.
--
-- Expressed as an invariant - a pin may only exist while cs_status is 'new' -
-- rather than as "clear on transition", so it also holds when a writer sends a
-- stale pinned_important=true on a row whose status is not changing in that
-- same statement. Enforcing it in the database covers every writer: the CS card
-- quick status change, the full lead save, forwarded-lead edits, the sheet sync
-- and anything added later.
--
-- is_important is deliberately untouched: the lead stays flagged important, it
-- just stops being pinned to the top.
CREATE OR REPLACE FUNCTION public.tg_pin_important_only_while_new()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.pinned_important
     AND NEW.cs_status IS DISTINCT FROM 'new'::public.cs_status THEN
    NEW.pinned_important := false;
  END IF;
  RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION public.tg_pin_important_only_while_new() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_qualified_leads_pin_only_while_new ON public.qualified_leads;
CREATE TRIGGER trg_qualified_leads_pin_only_while_new
  BEFORE INSERT OR UPDATE ON public.qualified_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_pin_important_only_while_new();

-- Clear pins already stranded on leads that have moved past 'new'.
--
-- trg_qualified_leads_updated_at is suspended for this one statement so the
-- cleanup does not bump updated_at: app.forwarded-leads.tsx orders by
-- updated_at DESC, and bumping it would shuffle historical leads to the top of
-- that list for a change nobody made today.
ALTER TABLE public.qualified_leads DISABLE TRIGGER trg_qualified_leads_updated_at;
UPDATE public.qualified_leads
SET pinned_important = false
WHERE pinned_important
  AND cs_status IS DISTINCT FROM 'new'::public.cs_status;
ALTER TABLE public.qualified_leads ENABLE TRIGGER trg_qualified_leads_updated_at;
