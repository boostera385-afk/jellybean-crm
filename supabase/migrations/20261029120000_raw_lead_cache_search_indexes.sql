-- =========================================================
-- Raw Leads search/area filter indexes
-- ---------------------------------------------------------
-- The Raw Leads page searches with ILIKE '%term%' and filters by area over
-- JSON fields of raw_lead_cache (see applySearchAndFilters in
-- src/lib/raw-leads.functions.ts). Without matching indexes every search did a
-- full sequential scan, reading JSON from every row, which blew past the
-- statement timeout (error 57014) once the table grew large.
--
-- Trigram GIN indexes make the ILIKE searches index-backed; btree functional
-- indexes serve the exact-match Area filter. pg_trgm is already used elsewhere
-- in this database.
--
-- NOTE: these are plain CREATE INDEX statements so they run inside the
-- migration transaction. On a very large table the build briefly locks writes;
-- to avoid that, an operator can instead run the CONCURRENTLY form of each
-- statement by hand in the SQL editor (outside a transaction) before applying.
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- --- Search box: ILIKE '%term%' across these columns/JSON fields ---
CREATE INDEX IF NOT EXISTS idx_rlc_phone_trgm
  ON public.raw_lead_cache USING gin (phone extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rlc_lead_link_trgm
  ON public.raw_lead_cache USING gin (lead_link extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rlc_account_name_trgm
  ON public.raw_lead_cache USING gin ((data->>'Account Name') extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rlc_post_text_trgm
  ON public.raw_lead_cache USING gin ((data->>'Post Text') extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rlc_account_area_trgm
  ON public.raw_lead_cache USING gin ((data->>'Account Area') extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rlc_sub_area_trgm
  ON public.raw_lead_cache USING gin ((data->>'Sub Area / Neighborhood') extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rlc_incog_account_trgm
  ON public.raw_lead_cache USING gin ((data->>'Incog Account') extensions.gin_trgm_ops);

-- --- Area filter: exact equality on the JSON area fields ---
CREATE INDEX IF NOT EXISTS idx_rlc_account_area_eq
  ON public.raw_lead_cache ((data->>'Account Area'));

CREATE INDEX IF NOT EXISTS idx_rlc_sub_area_eq
  ON public.raw_lead_cache ((data->>'Sub Area / Neighborhood'));
