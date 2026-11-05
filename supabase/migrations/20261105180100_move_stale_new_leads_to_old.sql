-- Move leads still in "New to contact" more than two months after they were
-- created to "Old Leads", so "New to contact" holds only leads to work now.
--
-- One-time and by a fixed date (two months before 5 Nov 2026), so re-running
-- it, or running it on another copy of the database, moves the same leads.
-- Every move lands in the lead's status history as a system entry with this
-- note. Nothing else about the lead changes; a person can move it back.
SELECT set_config('app.lead_status_note',
  'Moved to Old Leads: still New to contact more than 2 months after the lead was created', true);

UPDATE public.qualified_leads
   SET cs_status = 'old_lead'::public.cs_status
 WHERE cs_status = 'new'::public.cs_status
   AND created_at < '2026-09-05 00:00:00+00';

SELECT set_config('app.lead_status_note', '', true);

NOTIFY pgrst, 'reload schema';
