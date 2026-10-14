-- Reduce live-visitor latency: keep the aggregate counters on crisp_workspaces
-- in step with webhook presence events instead of only on the ~20s REST
-- reconciliation.
--
-- Before this change live_visitor_count/active_visitor_count were written only
-- by the REST reconciler (crisp_finish_presence). Because the overview reads
-- max(reported_count, online_rows), an arrival showed up immediately (a new
-- is_online row) but a DEPARTURE stayed inflated until the next reconcile ran
-- (up to ~20s, longer under cooldown): the webhook flipped is_online=false yet
-- never lowered the stored counter, so the max() held the stale-high number.
--
-- Patching crisp_apply_event to recompute both counters from the live rows on
-- every presence event makes departures drop in the SAME transaction as the
-- crisp_visitors row change that already drives Supabase Realtime, so the UI
-- updates instantly in both directions. The REST reconciler still corrects any
-- drift (e.g. visitors we never received an event for) and remains the sole
-- owner of visitors_limited.
DO $$
DECLARE
  definition text;
  anchor text := '  -- Notification/control events never rewrite conversation message summaries.';
BEGIN
  definition := pg_get_functiondef('public.crisp_apply_event(jsonb)'::regprocedure);
  IF strpos(definition, anchor) = 0 THEN
    RAISE EXCEPTION 'Unexpected crisp_apply_event definition (live-count anchor missing)';
  END IF;
  definition := replace(
    definition,
    anchor,
    '  -- Event-driven live counts: a departure lowers the stored counter at once,'
    || E'\n' ||
    '  -- without waiting for REST reconciliation. History imports never apply.'
    || E'\n' ||
    '  IF online IS NOT NULL AND coalesce(p_body->>''source'','''')<>''history'' THEN'
    || E'\n' ||
    '    UPDATE public.crisp_workspaces w SET'
    || E'\n' ||
    '      live_visitor_count=(SELECT count(*) FROM public.crisp_visitors v'
    || E'\n' ||
    '        WHERE v.crisp_website_id=website AND v.is_online),'
    || E'\n' ||
    '      active_visitor_count=(SELECT count(*) FROM public.crisp_visitors v'
    || E'\n' ||
    '        WHERE v.crisp_website_id=website AND v.is_online AND v.active),'
    || E'\n' ||
    '      updated_at=now()'
    || E'\n' ||
    '    WHERE w.crisp_website_id=website;'
    || E'\n' ||
    '  END IF;'
    || E'\n' ||
    anchor
  );
  EXECUTE definition;
END $$;
