-- No new tables, indexes, jobs, or data rewrites. Preserve the live policy
-- predicates (including installations with older note ownership rules).
SET lock_timeout = '3s';

DO $migration$
DECLARE p record; predicate text; check_predicate text;
BEGIN
  FOR p IN
    SELECT * FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('crisp_webhook_events', 'crisp_conversation_notes', 'service_area_bases')
      AND (qual LIKE '%auth.uid()%' OR with_check LIKE '%auth.uid()%')
  LOOP
    predicate := replace(p.qual, 'auth.uid()', '(SELECT auth.uid())');
    check_predicate := replace(p.with_check, 'auth.uid()', '(SELECT auth.uid())');
    -- This policy has no row-dependent inputs; cache the entire role check.
    IF p.tablename = 'crisp_webhook_events' AND predicate IS NOT NULL THEN
      predicate := '(SELECT ' || predicate || ')';
    END IF;
    EXECUTE format('ALTER POLICY %I ON %I.%I%s%s',
      p.policyname, p.schemaname, p.tablename,
      CASE WHEN predicate IS NULL THEN '' ELSE ' USING (' || predicate || ')' END,
      CASE WHEN check_predicate IS NULL THEN '' ELSE ' WITH CHECK (' || check_predicate || ')' END);
  END LOOP;
END
$migration$;

-- These read-only RPCs were bypassing their tables' existing Crisp-role RLS.
-- Invoker security preserves results for CS/admin and service-role workers,
-- while enforcing the same access rules as direct table reads.
ALTER FUNCTION public.get_crisp_workspace_summaries() SECURITY INVOKER;
ALTER FUNCTION public.get_crisp_conversations_page(text[], integer, integer, text) SECURITY INVOKER;
ALTER FUNCTION public.get_crisp_today_visitors_summary(timestamptz) SECURITY INVOKER;

-- All application objects in these bodies are already schema-qualified.
ALTER FUNCTION public.get_crisp_workspace_summaries() SET search_path = '';
ALTER FUNCTION public.get_crisp_conversations_page(text[], integer, integer, text) SET search_path = '';
ALTER FUNCTION public.get_crisp_today_visitors_summary(timestamptz) SET search_path = '';
ALTER FUNCTION public.is_crisp_masked_content(text) SET search_path = '';
ALTER FUNCTION public.crisp_messages_ignore_duplicates_trigger() SET search_path = '';
ALTER FUNCTION public.tg_raw_lead_cache_route_duplicates() SET search_path = '';

-- Full materialized-view refreshes are maintenance, not browser APIs. Leaving
-- these callable lets any client trigger expensive scans and refresh locks.
REVOKE EXECUTE ON FUNCTION public.refresh_lead_counter_materialized_views() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_mv_qualified_leads_status_counts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_mv_raw_lead_cache_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_lead_counter_materialized_views() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_mv_qualified_leads_status_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_mv_raw_lead_cache_counts() TO service_role;

RESET lock_timeout;
