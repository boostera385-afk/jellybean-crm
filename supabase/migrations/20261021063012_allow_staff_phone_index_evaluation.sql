-- Pure normalizer reads no tables. Staff writes need EXECUTE to maintain
-- phone-expression indexes. This does not grant access to any lead data.
GRANT EXECUTE ON FUNCTION public.lead_ai_phone(text) TO authenticated;
