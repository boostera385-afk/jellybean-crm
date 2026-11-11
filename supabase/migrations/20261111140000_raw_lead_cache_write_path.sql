-- raw_lead_cache write path + per-user count (from 7 days of postgres logs).
--
-- Recurring statement timeouts, every day, all on raw_lead_cache:
--   * count of category = X AND categorized_by = me (forwarded-leads "Not found"
--     badge): 9.5 s, because every matching row's heap page was read from disk
--     just to evaluate RLS on assigned_to.
--   * INSERT / category UPDATE / batch_update_raw_lead_decisions: the table
--     carried 33 indexes, and changing an indexed column (category, lead) is a
--     non-HOT update that writes to all of them, including 7 trigram GIN
--     indexes whose 4 MB pending lists are flushed synchronously by whichever
--     writer happens to overflow them.
--
-- The covering index was built with CREATE INDEX CONCURRENTLY before this
-- migration ran (IF NOT EXISTS keeps this file replayable on a fresh database).

CREATE INDEX IF NOT EXISTS idx_rlc_categorized_by_category_cover
  ON public.raw_lead_cache (categorized_by, category) INCLUDE (assigned_to);

-- Superseded by the covering index above (same leading columns).
DROP INDEX IF EXISTS public.idx_raw_lead_cache_categorized_by_category;
DROP INDEX IF EXISTS public.raw_lead_cache_categorized_by_idx;

-- Never or almost never used (0 and 2 scans lifetime); the assigned-myself
-- queue is served by the partial idx_raw_lead_cache_assigned_myself index.
DROP INDEX IF EXISTS public.raw_lead_cache_sheet_row_idx;
DROP INDEX IF EXISTS public.idx_raw_lead_cache_assigned_myself_at;

-- Keep the trigram indexes (the search's BitmapOr needs all seven) but flush
-- their pending lists in 512 kB steps instead of 4 MB stalls.
ALTER INDEX public.idx_rlc_post_text_trgm      SET (gin_pending_list_limit = 512);
ALTER INDEX public.idx_rlc_lead_link_trgm      SET (gin_pending_list_limit = 512);
ALTER INDEX public.idx_rlc_account_name_trgm   SET (gin_pending_list_limit = 512);
ALTER INDEX public.idx_rlc_sub_area_trgm       SET (gin_pending_list_limit = 512);
ALTER INDEX public.idx_rlc_incog_account_trgm  SET (gin_pending_list_limit = 512);
ALTER INDEX public.idx_rlc_account_area_trgm   SET (gin_pending_list_limit = 512);
ALTER INDEX public.idx_rlc_phone_trgm          SET (gin_pending_list_limit = 512);
