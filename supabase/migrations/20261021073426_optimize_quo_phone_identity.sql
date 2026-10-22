-- Keep every identity branch indexable; a correlated OR/unnest forced repeated scans.
CREATE FUNCTION public.lead_ai_extra_phones(p_phones text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT public.lead_ai_phone(n))
    FILTER (WHERE public.lead_ai_phone(n) IS NOT NULL),'{}'::text[])
  FROM unnest(p_phones) n
$$;
REVOKE ALL ON FUNCTION public.lead_ai_extra_phones(text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.lead_ai_extra_phones(text[]) TO authenticated,service_role;
CREATE INDEX qualified_leads_ai_extra_normalized ON public.qualified_leads
  USING gin(public.lead_ai_extra_phones(extra_numbers));

CREATE OR REPLACE FUNCTION public.lead_ai_phone_is_unique(p_lead_id uuid,p_phone text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p_phone IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM public.qualified_leads q WHERE q.id<>p_lead_id
      AND public.lead_ai_phone(q.customer_number)=p_phone)
    AND NOT EXISTS(SELECT 1 FROM public.qualified_leads q WHERE q.id<>p_lead_id
      AND public.lead_ai_phone(q.customer_number_2)=p_phone)
    AND NOT EXISTS(SELECT 1 FROM public.qualified_leads q WHERE q.id<>p_lead_id
      AND public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[p_phone])
$$;
REVOKE ALL ON FUNCTION public.lead_ai_phone_is_unique(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lead_ai_phone_is_unique(uuid,text) TO service_role;
