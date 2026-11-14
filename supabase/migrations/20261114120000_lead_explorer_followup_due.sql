-- Align Explorer "follow-up due" with CS Pipeline: due means the follow-up time has
-- passed AND the lead is still in Need Follow Up. Query-only; no table, index,
-- policy, enum or grant changes. Applied migrations are not edited.
DO $migration$
DECLARE
  definition text;
  rewritten text;
  old_rule constant text := $a$q.followup_at <= now()$a$;
  new_rule constant text := $b$q.followup_at <= now() AND q.cs_status = ''need_follow_up''$b$;
BEGIN
  SELECT pg_get_functiondef('public.lead_explorer_query(text,text,jsonb,jsonb,jsonb,jsonb,uuid)'::regprocedure)
    INTO definition;
  rewritten := replace(definition, old_rule, new_rule);
  -- Exactly two occurrences: the `due` filter and the summary count.
  IF (length(rewritten) - length(definition)) <> 2 * (length(new_rule) - length(old_rule)) THEN
    RAISE EXCEPTION 'Unexpected lead_explorer_query definition; follow-up rule not rewritten';
  END IF;
  EXECUTE rewritten;
END
$migration$;
