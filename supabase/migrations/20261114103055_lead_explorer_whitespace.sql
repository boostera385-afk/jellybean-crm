-- Query-only whitespace handling, matching normalizeLeadService/branchKey.
-- Do not rewrite historical data or change the existing shared normalization RPC.
CREATE FUNCTION public.lead_explorer_trim(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER
RETURNS NULL ON NULL INPUT
SET search_path = public
AS $function$
  SELECT regexp_replace(p_value, '^\s+|\s+$', '', 'g')
$function$;

REVOKE ALL ON FUNCTION public.lead_explorer_trim(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_explorer_trim(text) TO authenticated;

DO $migration$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('public.lead_explorer_query(text,text,jsonb,jsonb,jsonb,jsonb,uuid)'::regprocedure)
    INTO definition;
  -- This affects only the newly added Explorer function (including q.%I
  -- templates). Existing helpers, policies and lead values remain untouched.
  definition := replace(definition, 'btrim(q.', 'public.lead_explorer_trim(q.');
  EXECUTE definition;
END
$migration$;
