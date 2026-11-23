-- Stop paying OpenAI twice for the same work.
--
-- 1. Auto-compose (first CS reply). A new lead is auto-composed by the person
--    who sent it AND by every CS user with the CS Leads page open (realtime
--    INSERT handler). They all started a full compose at once; only one draft
--    could be saved. Over 14 days ~37% of compose runs were these duplicates.
--    cs_claim_auto_compose lets exactly one caller per lead go ahead. The
--    manual "rephrase" button does not use it, so a person can always compose
--    again on purpose.
--
-- 2. Raw lead AI check. Two users with Raw Leads open could auto-check the
--    same batch of posts (the shared "AI lock" is advisory and read once per
--    page load). claim_raw_leads_for_ai hands each post to one request at a
--    time; a claim older than 3 minutes counts as abandoned. The server also
--    skips posts that already have a yes/no decision.
--
-- Both tables are written only by the server (service role).

-- ── 1. Auto-compose claims ───────────────────────────────────────────────────
CREATE TABLE public.cs_auto_compose_claims (
  lead_id uuid PRIMARY KEY REFERENCES public.qualified_leads(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cs_auto_compose_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cs_auto_compose_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.cs_auto_compose_claims TO service_role;

-- True for the first caller for this lead, false for everyone after.
CREATE FUNCTION public.cs_claim_auto_compose(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH claimed AS (
    INSERT INTO public.cs_auto_compose_claims (lead_id)
    VALUES (p_lead_id)
    ON CONFLICT (lead_id) DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
REVOKE ALL ON FUNCTION public.cs_claim_auto_compose(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cs_claim_auto_compose(uuid) TO service_role;

-- ── 2. Raw lead AI claims ────────────────────────────────────────────────────
CREATE TABLE public.raw_lead_ai_claims (
  row_key text PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX raw_lead_ai_claims_claimed_at_idx ON public.raw_lead_ai_claims (claimed_at);
ALTER TABLE public.raw_lead_ai_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.raw_lead_ai_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raw_lead_ai_claims TO service_role;

-- Returns the row keys this caller may classify now: ones nobody holds, or
-- whose claim is older than 3 minutes. Keys are claimed in sorted order so two
-- overlapping batches cannot deadlock. Claims older than a day are cleared:
-- by then the post has a decision and the server skips it before claiming.
CREATE FUNCTION public.claim_raw_leads_for_ai(p_row_keys text[])
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.raw_lead_ai_claims WHERE claimed_at < now() - interval '1 day';
  RETURN QUERY
  INSERT INTO public.raw_lead_ai_claims AS c (row_key)
  SELECT k FROM (SELECT DISTINCT k FROM unnest(p_row_keys) AS k WHERE k IS NOT NULL) d ORDER BY k
  ON CONFLICT (row_key) DO UPDATE SET claimed_at = now()
    WHERE c.claimed_at < now() - interval '3 minutes'
  RETURNING c.row_key;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_raw_leads_for_ai(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_raw_leads_for_ai(text[]) TO service_role;
