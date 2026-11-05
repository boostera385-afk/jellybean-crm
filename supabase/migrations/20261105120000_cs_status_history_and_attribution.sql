-- Status attribution, status history, and restoring pre-4-Nov leads.
--
-- 1. Who changed the status. The lead keeps the id and display name of the
--    person who last set its status (cs_status_updated_by[_name]); an AI write
--    clears them, so the pipeline shows either "AI updated status" or the name.
--
-- 2. History. Every real status change (insert or update) is appended to
--    lead_status_history with its source (user / ai / system), the person and
--    the time. Rows are written only by the trigger; clients can read the rows
--    of leads they can already see and nothing else.
--
-- 3. Old leads keep their old view. AI pipeline automation was meant for leads
--    from 4 Nov 2026 on, but the 20261104092301 backfill enabled it for every
--    Delivered lead. Leads created before the cutoff go back to the status a
--    person last set before automation went live, automation is switched off
--    for them for good, and the AI result stays available as the comparison
--    chip next to the manual status, as before.
--
-- Who counts as AI: a write that stamps the AI marker with a fresh AI time and
-- no signed-in user (the worker, and the scheduled 6h flip, which used to be
-- recorded as a human edit because pg_cron is not the service role).

-- ── Cutoff ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cs_ai_automation_cutoff()
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = '' AS
$$ SELECT '2026-11-04 00:00:00+05'::timestamptz $$;

-- ── Attribution columns ─────────────────────────────────────────────────────
ALTER TABLE public.qualified_leads
  ADD COLUMN IF NOT EXISTS cs_status_updated_by uuid,
  ADD COLUMN IF NOT EXISTS cs_status_updated_by_name text;

-- The signed-in user's own display name, for the trigger below. Returns
-- nothing about anyone else.
CREATE OR REPLACE FUNCTION public.current_profile_name()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(nullif(btrim(p.full_name), ''), p.email)
  FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.current_profile_name() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_profile_name() TO authenticated, service_role;

-- ── History table ───────────────────────────────────────────────────────────
-- Statuses are text, not the enum: backfilled log entries can carry labels
-- from before the status consolidation, and history must never fail to write.
CREATE TABLE IF NOT EXISTS public.lead_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES public.qualified_leads(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  source text NOT NULL CHECK (source IN ('user', 'ai', 'system')),
  changed_by uuid,
  changed_by_name text,
  note text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_status_history_lead_idx
  ON public.lead_status_history (lead_id, changed_at, id);

ALTER TABLE public.lead_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lead_status_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lead_status_history TO authenticated;
GRANT ALL ON TABLE public.lead_status_history TO service_role;
DROP POLICY IF EXISTS lead_status_history_read ON public.lead_status_history;
-- Visible exactly when the lead itself is visible to the reader (the subquery
-- runs under the reader's own qualified_leads policies).
CREATE POLICY lead_status_history_read ON public.lead_status_history
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.qualified_leads q WHERE q.id = lead_id));

-- ── Backfill history from what was already recorded ─────────────────────────
-- Human changes: status-bearing activity logs. AI changes: classified runs and
-- the 6h no-reply flip since automation went live, on leads automation covered.
-- Everything is merged per lead in time order and only real changes are kept.
WITH events AS (
  SELECT q.id AS lead_id, q.created_at AS at, 'new'::text AS status, 'system'::text AS source,
         NULL::uuid AS actor, NULL::text AS actor_name, 'Lead created'::text AS note, 0 AS prio
  FROM public.qualified_leads q
  UNION ALL
  SELECT q.id, l.created_at, l.metadata->>'status', 'user', l.actor_id, l.actor_name, NULL, 1
  FROM public.activity_logs l
  JOIN public.qualified_leads q ON q.id::text = l.entity_id::text
  WHERE l.entity_type = 'qualified_lead'
    AND l.action IN ('cs.status_changed', 'cs.updated')
    AND coalesce(l.metadata->>'status', '') <> ''
  UNION ALL
  SELECT r.lead_id, r.finished_at, r.result->>'status', 'ai', NULL, NULL, NULL, 2
  FROM public.lead_ai_status_runs r
  JOIN public.qualified_leads q ON q.id = r.lead_id
  WHERE q.ai_status_automation_started_at IS NOT NULL
    AND r.outcome = 'classified'
    AND r.finished_at >= '2026-11-04 09:44:42+00'
    AND coalesce(r.result->>'status', '') <> ''
  UNION ALL
  SELECT a.lead_id, a.analyzed_at, 'cx_didnt_replied', 'ai', NULL, NULL, 'No reply after 6 hours', 3
  FROM public.lead_ai_status a
  JOIN public.qualified_leads q ON q.id = a.lead_id
  WHERE q.ai_status_automation_started_at IS NOT NULL
    AND a.reason_code = 'no_reply_after_6h'
    AND a.analyzed_at >= '2026-11-04 09:44:42+00'
), ordered AS (
  SELECT e.*, lag(e.status) OVER (PARTITION BY e.lead_id ORDER BY e.at, e.prio) AS prev
  FROM events e
)
INSERT INTO public.lead_status_history
  (lead_id, from_status, to_status, source, changed_by, changed_by_name, note, changed_at)
SELECT lead_id, prev, status, source, actor, actor_name, note, at
FROM ordered
WHERE prev IS NULL OR prev IS DISTINCT FROM status;

-- Where the reconstructed trail does not end at the current status (an
-- unlogged change), close it with the status as it stands now.
INSERT INTO public.lead_status_history (lead_id, from_status, to_status, source, note, changed_at)
SELECT q.id, h.to_status, q.cs_status::text, 'system',
       'Status recorded when history started (earlier change was not logged)', now()
FROM public.qualified_leads q
JOIN LATERAL (
  SELECT x.to_status FROM public.lead_status_history x
  WHERE x.lead_id = q.id ORDER BY x.changed_at DESC, x.id DESC LIMIT 1
) h ON true
WHERE h.to_status IS DISTINCT FROM q.cs_status::text;

-- Attribution for statuses a person set: the actor of the last log entry that
-- matches the current status.
UPDATE public.qualified_leads q
   SET cs_status_updated_by = h.changed_by,
       cs_status_updated_by_name = h.changed_by_name
  FROM (
    SELECT DISTINCT ON (lead_id) lead_id, to_status, source, changed_by, changed_by_name
    FROM public.lead_status_history ORDER BY lead_id, changed_at DESC, id DESC
  ) h
 WHERE h.lead_id = q.id AND h.source = 'user' AND h.to_status = q.cs_status::text
   AND q.cs_status_updated_by_ai IS NOT TRUE;

-- ── Provenance trigger (BEFORE) ─────────────────────────────────────────────
-- An AI write is one that stamps the AI marker together with a fresh AI time
-- and carries no signed-in user: the worker (service key) and the scheduled
-- 6h flip (pg_cron) both do exactly that. Anything else that is not the
-- service key is a person, as before; a signed-in user is always a person.
CREATE OR REPLACE FUNCTION public.cs_status_write_is_ai(
  p_new public.qualified_leads, p_old public.qualified_leads
) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT auth.uid() IS NULL
     AND p_new.cs_status_updated_by_ai IS TRUE
     AND p_new.cs_status_ai_updated_at IS DISTINCT FROM p_old.cs_status_ai_updated_at
$$;

CREATE OR REPLACE FUNCTION public.tg_qualified_lead_status_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  is_ai boolean := public.cs_status_write_is_ai(NEW, OLD);
BEGIN
  IF NEW.cs_status IS DISTINCT FROM OLD.cs_status THEN
    IF is_ai THEN
      NEW.cs_status_updated_by := NULL;
      NEW.cs_status_updated_by_name := NULL;
    ELSIF actor IS NOT NULL OR current_user <> 'service_role' THEN
      -- A person owns this decision: drop the AI marker, close any review.
      NEW.cs_status_updated_by_ai := false;
      NEW.cs_status_ai_updated_at := NULL;
      NEW.cs_status_human_updated_at := now();
      NEW.ai_review_required := false;
      NEW.ai_review_reason := NULL;
      NEW.cs_status_updated_by := actor;
      NEW.cs_status_updated_by_name :=
        CASE WHEN actor IS NOT NULL THEN public.current_profile_name() END;
      IF NEW.cs_status = 'converted'::public.cs_status
         AND OLD.ai_status_automation_started_at IS NULL THEN
        NEW.ai_status_automation_started_at := now();
      END IF;
    END IF;
  ELSIF actor IS NOT NULL AND OLD.cs_status_updated_by_ai
        AND NEW.cs_status_updated_by_ai IS NOT TRUE THEN
    -- A person confirmed the status the AI set: they own it now.
    NEW.cs_status_updated_by := actor;
    NEW.cs_status_updated_by_name := public.current_profile_name();
  ELSIF is_ai AND OLD.cs_status_updated_by_ai IS NOT TRUE THEN
    -- The worker re-confirming a status a person set is not an AI update:
    -- keep who actually set it.
    NEW.cs_status_updated_by_ai := OLD.cs_status_updated_by_ai;
    NEW.cs_status_ai_updated_at := OLD.cs_status_ai_updated_at;
  END IF;
  -- Automation is for leads created from the cutoff on, whoever asks.
  IF NEW.created_at < public.cs_ai_automation_cutoff() THEN
    NEW.ai_status_automation_started_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.tg_qualified_lead_status_provenance() FROM PUBLIC;

DROP TRIGGER IF EXISTS qualified_lead_status_provenance ON public.qualified_leads;
CREATE TRIGGER qualified_lead_status_provenance
  BEFORE UPDATE OF cs_status, ai_status_automation_started_at ON public.qualified_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_qualified_lead_status_provenance();

-- ── History trigger (AFTER) ─────────────────────────────────────────────────
-- SECURITY DEFINER only so it may insert into the history table; who made the
-- change is read from the row the BEFORE trigger already attributed.
CREATE OR REPLACE FUNCTION public.tg_qualified_lead_status_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source text;
  v_actor uuid;
  v_name text;
  v_note text := nullif(current_setting('app.lead_status_note', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.cs_status IS NOT DISTINCT FROM OLD.cs_status THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.cs_status_updated_by_ai AND auth.uid() IS NULL
     AND NEW.cs_status_ai_updated_at IS DISTINCT FROM OLD.cs_status_ai_updated_at THEN
    v_source := 'ai';
  ELSIF auth.uid() IS NOT NULL THEN
    v_source := 'user';
    v_actor := auth.uid();
    v_name := (SELECT coalesce(nullif(btrim(p.full_name), ''), p.email)
               FROM public.profiles p WHERE p.user_id = v_actor LIMIT 1);
  ELSE
    v_source := 'system';
  END IF;
  INSERT INTO public.lead_status_history
    (lead_id, from_status, to_status, source, changed_by, changed_by_name, note)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.cs_status::text END,
    NEW.cs_status::text,
    v_source, v_actor, v_name,
    coalesce(v_note, CASE WHEN TG_OP = 'INSERT' THEN 'Lead created' END)
  );
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.tg_qualified_lead_status_history() FROM PUBLIC;

DROP TRIGGER IF EXISTS qualified_lead_status_history ON public.qualified_leads;
CREATE TRIGGER qualified_lead_status_history
  AFTER INSERT OR UPDATE OF cs_status ON public.qualified_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_qualified_lead_status_history();

-- ── Restore pre-cutoff leads the AI changed ─────────────────────────────────
-- Back to the status a person last set before automation went live, with that
-- person as the owner again. The restore itself lands in history as a system
-- entry, after the AI change it undoes, so the trail stays honest.
CREATE TEMP TABLE restore_targets AS
SELECT DISTINCT ON (q.id)
       q.id, (l.metadata->>'status') AS status, l.actor_id, l.actor_name, l.created_at
FROM public.qualified_leads q
JOIN public.activity_logs l ON l.entity_id::text = q.id::text
WHERE q.created_at < public.cs_ai_automation_cutoff()
  AND q.cs_status_updated_by_ai
  AND l.entity_type = 'qualified_lead'
  AND l.action IN ('cs.status_changed', 'cs.updated')
  AND coalesce(l.metadata->>'status', '') <> ''
  AND l.created_at < '2026-11-04 09:44:42+00'
  AND (l.metadata->>'status') IN (SELECT unnest(enum_range(NULL::public.cs_status))::text)
ORDER BY q.id, l.created_at DESC;

SELECT set_config('app.lead_status_note',
  'Restored manual status (AI automation does not apply to leads before 4 Nov)', true);

UPDATE public.qualified_leads q
   SET cs_status = t.status::public.cs_status,
       cs_status_updated_by_ai = false,
       cs_status_ai_updated_at = NULL,
       ai_review_required = false,
       ai_review_reason = NULL
  FROM restore_targets t
 WHERE t.id = q.id;

SELECT set_config('app.lead_status_note', '', true);

-- Columns only, so neither trigger fires again.
UPDATE public.qualified_leads q
   SET cs_status_updated_by = t.actor_id,
       cs_status_updated_by_name = t.actor_name,
       cs_status_human_updated_at = t.created_at
  FROM restore_targets t
 WHERE t.id = q.id;

-- Every pre-cutoff lead: automation off, no AI marker or review flag left.
UPDATE public.qualified_leads
   SET ai_status_automation_started_at = NULL,
       cs_status_updated_by_ai = false,
       cs_status_ai_updated_at = NULL,
       ai_review_required = false,
       ai_review_reason = NULL
 WHERE created_at < public.cs_ai_automation_cutoff()
   AND (ai_status_automation_started_at IS NOT NULL OR cs_status_updated_by_ai
        OR ai_review_required);

DROP TABLE restore_targets;

NOTIFY pgrst, 'reload schema';
