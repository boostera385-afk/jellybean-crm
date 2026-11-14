-- Keep the Explorer-only trim helper inlineable. No table/index/policy changes.
-- This character set is ECMAScript String.trim whitespace, including NBSP/BOM.
CREATE OR REPLACE FUNCTION public.lead_explorer_trim(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER
RETURNS NULL ON NULL INPUT
AS $function$
  SELECT pg_catalog.btrim(p_value,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$function$;
-- Only this pure, qualified-builtin helper omits SET to permit SQL inlining.
-- The grouped-count/result RPC remains STABLE INVOKER SET search_path=public.
ALTER FUNCTION public.lead_explorer_trim(text) RESET search_path;
