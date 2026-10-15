-- Live-visitor latency fixes.
--
-- Companion to 20261014150000 (event-driven live counts). That change made the
-- stored counters move with webhook presence events; this one makes those
-- changes actually reach the browser quickly, and widens the set of Crisp
-- payload shapes that count as a presence transition.

-- 1. REPLICA IDENTITY FULL for the two tables the live-visitor UI subscribes to.
--    20260827110000 did this for crisp_conversations/crisp_messages/
--    crisp_webhook_events, but crisp_visitors and crisp_workspaces were created
--    later and never got it. Without it, an UPDATE's old tuple carries only the
--    primary key, so Supabase Realtime cannot evaluate RLS against the previous
--    row and drops or degrades UPDATE/DELETE broadcasts on an RLS table. Those
--    are exactly the events that matter here: an existing visitor going offline
--    or changing page is an UPDATE, not an INSERT, and the counters on
--    crisp_workspaces only ever change by UPDATE. Losing them forced the UI to
--    wait for the polling fallback.
ALTER TABLE public.crisp_visitors REPLICA IDENTITY FULL;
ALTER TABLE public.crisp_workspaces REPLICA IDENTITY FULL;

-- 2. Cache the role lookups in the Crisp read policies, matching the pattern
--    20260829120100 applied to qualified_leads. Realtime re-evaluates the
--    SELECT policy per subscriber per changed row before broadcasting, so a
--    bare auth.uid() + EXISTS subquery is re-planned far more often here than a
--    normal read would be. Semantics are unchanged: admin, cs_admin and cs.
GRANT EXECUTE ON FUNCTION public.current_user_has_role_text(text) TO authenticated;

ALTER POLICY "Crisp visitors select for cs roles"
ON public.crisp_visitors
USING (
  (SELECT public.current_user_has_role_text('admin'))
  OR (SELECT public.current_user_has_role_text('cs_admin'))
  OR (SELECT public.current_user_has_role_text('cs'))
);

ALTER POLICY "Crisp daily visitors select for cs roles"
ON public.crisp_visitor_daily_visits
USING (
  (SELECT public.current_user_has_role_text('admin'))
  OR (SELECT public.current_user_has_role_text('cs_admin'))
  OR (SELECT public.current_user_has_role_text('cs'))
);

ALTER POLICY "Crisp workspaces select access for cs roles"
ON public.crisp_workspaces
USING (
  (SELECT public.current_user_has_role_text('admin'))
  OR (SELECT public.current_user_has_role_text('cs_admin'))
  OR (SELECT public.current_user_has_role_text('cs'))
);

-- 3. Make the REST reconciliation interval tunable per workspace instead of
--    hardcoded at 20 seconds.
--
--    The interval is NOT lowered by default on purpose. crispFetch reserves
--    budget for every call (crisp_reserve_request), and the background budget is
--    crisp_request_limit - crisp_interactive_reserve = 9000 calls per rolling
--    24h by default. One reconcile costs 1 call when the site is empty and ~2
--    (count + one list page) when it is not, so a 20s interval already spends
--    4320-8640 of that budget. Dropping it to 5s would cost 17k-34k calls/day:
--    the reservation would start failing, reconciliation would stall completely
--    and the "visitor reconciliation is delayed" banner would stick. Lower this
--    only together with a raised crisp_request_limit that the Crisp plan allows.
ALTER TABLE public.crisp_workspaces
  ADD COLUMN visitor_sync_interval_seconds integer NOT NULL DEFAULT 20
    CHECK (visitor_sync_interval_seconds BETWEEN 5 AND 300);

CREATE OR REPLACE FUNCTION public.crisp_claim_presence(p_website_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE token uuid := gen_random_uuid();
BEGIN
  UPDATE public.crisp_workspaces SET visitor_sync_lease=token,
    visitor_sync_lease_until=now()+interval '2 minutes',visitor_synced_at=now()
  WHERE crisp_website_id=p_website_id AND enabled
    AND (visitor_sync_lease_until IS NULL OR visitor_sync_lease_until <= now())
    AND (visitor_synced_at IS NULL
      OR visitor_synced_at <= now()-make_interval(secs=>visitor_sync_interval_seconds));
  IF FOUND THEN RETURN token; END IF;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.crisp_claim_presence(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_claim_presence(text) TO service_role;

-- 4. Recognize more Crisp presence payloads in crisp_apply_event.
--
--    The availability field is read as a bare string (d->>'availability'). Crisp
--    also sends it as an object, e.g. {"availability":{"type":"online"}}. In that
--    shape d->>'availability' returns the object's JSON text, which is NOT NULL
--    and never equals 'online' -- so the CASE fell through to
--    "availability IS NOT NULL" and marked an ARRIVING visitor OFFLINE. That is
--    worse than ignoring the event, and it also meant a nested offline payload
--    never registered a departure. Normalize both shapes first, then reuse the
--    existing logic unchanged.
DO $$
DECLARE
  definition text;
  declare_anchor text := '  online boolean; activity boolean;';
  activity_anchor text := '  activity := (e=''message:send'' AND NOT operator_message) OR e LIKE ''session:sync:%''';
BEGIN
  definition := pg_get_functiondef('public.crisp_apply_event(jsonb)'::regprocedure);
  IF strpos(definition, declare_anchor) = 0 OR strpos(definition, activity_anchor) = 0 THEN
    RAISE EXCEPTION 'Unexpected crisp_apply_event definition (availability anchors missing)';
  END IF;
  IF strpos(definition, 'd->>''availability''') = 0 THEN
    RAISE EXCEPTION 'Unexpected crisp_apply_event definition (availability read missing)';
  END IF;

  -- Order matters: redirect every existing availability read to the normalized
  -- variable BEFORE inserting the normalization itself (which reads the raw key).
  definition := replace(definition, 'd->>''availability''', 'avail');
  definition := replace(definition, declare_anchor, declare_anchor || ' avail text;');
  definition := replace(
    definition,
    activity_anchor,
    '  -- Crisp sends availability as either "online" or {"type":"online"}.'
    || E'\n' ||
    '  avail := CASE jsonb_typeof(d->''availability'')'
    || E'\n' ||
    '    WHEN ''string'' THEN d->>''availability'''
    || E'\n' ||
    '    WHEN ''object'' THEN coalesce(d#>>''{availability,type}'',d#>>''{availability,status}'')'
    || E'\n' ||
    '    ELSE NULL END;'
    || E'\n' ||
    activity_anchor
  );
  EXECUTE definition;
END $$;
