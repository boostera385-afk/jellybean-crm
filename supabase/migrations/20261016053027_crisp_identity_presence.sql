-- Identity-first discovery. Fast reads upsert identities but never prove absence.
-- Version matches the production migration recorded by Supabase MCP.
-- Full count + list validation remains the only REST absence proof.
ALTER TABLE public.crisp_workspaces
  ADD COLUMN visitor_identity_checked_at timestamptz,
  ADD COLUMN visitor_count_checked_at timestamptz,
  ADD COLUMN visitor_effective_interval_seconds integer NOT NULL DEFAULT 12,
  ADD COLUMN visitor_budget_used integer NOT NULL DEFAULT 0,
  ADD COLUMN visitor_request_cost numeric NOT NULL DEFAULT 1,
  ADD COLUMN visitor_last_duration_ms integer,
  ADD COLUMN visitor_last_mode text,
  ADD COLUMN presence_feed text NOT NULL DEFAULT 'polling' CHECK (presence_feed IN ('polling','plugin')),
  ADD COLUMN last_presence_event_at timestamptz;

-- Keep the existing signature, leases, upserts, greeting triggers and observation
-- watermarks. Fail loudly if an unrelated deployment changed the expected body.
DO $$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef('public.crisp_finish_presence(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text)'::regprocedure);
  anchor := 'live_visitor_count=CASE WHEN p_error IS NULL THEN coalesce(p_count,jsonb_array_length(p_rows)) ELSE live_visitor_count END';
  IF strpos(definition,anchor)=0 OR strpos(definition,'last_full_presence_at=CASE WHEN p_error IS NULL AND p_complete')=0 THEN
    RAISE EXCEPTION 'Unexpected presence finisher definition';
  END IF;
  definition := replace(definition,anchor,
    'live_visitor_count=CASE WHEN p_error IS NULL THEN coalesce(p_count,greatest(live_visitor_count,jsonb_array_length(p_rows))) ELSE live_visitor_count END');
  definition := replace(definition,
    'visitors_limited=CASE WHEN p_error IS NULL THEN p_limited ELSE visitors_limited END',
    'visitors_limited=CASE WHEN p_error IS NULL THEN coalesce(p_limited,visitors_limited) ELSE visitors_limited END');
  definition := replace(definition,
    'CASE WHEN p_error IS NULL AND p_complete THEN now()',
    'CASE WHEN p_error IS NULL AND p_complete AND NOT coalesce(p_limited,true) THEN now()');
  definition := replace(definition,
    'visitor_sync_error=p_error,',
    'visitor_sync_error=p_error,
    visitor_identity_checked_at=CASE WHEN p_error IS NULL AND (p_count IS NULL OR jsonb_array_length(p_rows)>0 OR (p_complete AND NOT coalesce(p_limited,true))) THEN now() ELSE visitor_identity_checked_at END,
    visitor_count_checked_at=CASE WHEN p_count IS NOT NULL THEN now() ELSE visitor_count_checked_at END,');
  EXECUTE definition;
END $$;

CREATE FUNCTION public.crisp_finish_presence_v2(p_website_id text,p_token uuid,p_started_at timestamptz,
  p_rows jsonb,p_complete boolean,p_count integer,p_active integer,p_limited boolean,p_error text,
  p_requests integer,p_duration_ms integer,p_mode text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NOT public.crisp_finish_presence(p_website_id,p_token,p_started_at,p_rows,p_complete,p_count,p_active,p_limited,p_error) THEN RETURN false; END IF;
  UPDATE public.crisp_workspaces SET
    visitor_request_cost=round(visitor_request_cost*0.8+greatest(1,least(11,p_requests))*0.2,3),
    visitor_last_duration_ms=greatest(0,least(120000,p_duration_ms)),
    visitor_last_mode=CASE WHEN p_mode IN ('full','identity') THEN p_mode ELSE 'unknown' END
  WHERE crisp_website_id=p_website_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.crisp_finish_presence_v2(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text,integer,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_finish_presence_v2(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text,integer,integer,text) TO service_role;

CREATE OR REPLACE FUNCTION public.crisp_claim_presence(p_website_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE token uuid:=gen_random_uuid(); w public.crisp_workspaces; used integer; budget integer; gap integer;
BEGIN
  SELECT * INTO w FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND enabled FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR w.crisp_cooldown_until>now() OR w.visitor_sync_lease_until>now() THEN RETURN NULL; END IF;
  SELECT coalesce(sum(requests),0) INTO used FROM public.crisp_api_usage
    WHERE crisp_website_id=p_website_id AND bucket_at>=date_trunc('hour',now()-interval '24 hours');
  budget:=greatest(1,w.crisp_request_limit-w.crisp_interactive_reserve);
  -- Allow 15% headroom for paging, jitter and other background callers. This is
  -- an adaptive best effort, never permission to exceed crisp_reserve_request.
  gap:=greatest(w.visitor_sync_interval_seconds,ceil(86400*greatest(1,w.visitor_request_cost)/(budget*0.85))::integer,
    CASE WHEN used>=budget*0.97 THEN 120 WHEN used>=budget*0.90 THEN 60 WHEN used>=budget*0.80 THEN 30 ELSE 5 END);
  gap:=least(300,gap);
  IF w.visitor_synced_at IS NOT NULL AND w.visitor_synced_at>now()-make_interval(secs=>gap) THEN RETURN NULL; END IF;
  UPDATE public.crisp_workspaces SET visitor_sync_lease=token,
    visitor_sync_lease_until=now()+interval '2 minutes',visitor_synced_at=now(),
    visitor_effective_interval_seconds=gap,visitor_budget_used=used
  WHERE crisp_website_id=p_website_id;
  RETURN token;
END $$;
REVOKE ALL ON FUNCTION public.crisp_claim_presence(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_claim_presence(text) TO service_role;

-- Record real signed availability receipts; silence alone does NOT imply a
-- healthy/disconnected feed. Only the plugin endpoint adds this trusted marker.
DO $$
DECLARE definition text; anchor text:='  session := coalesce(d->>''session_id'',p_body->>''session_id'');';
BEGIN
  definition:=pg_get_functiondef('public.crisp_apply_event(jsonb)'::regprocedure);
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected event function definition'; END IF;
  definition:=replace(definition,anchor,
    '  IF p_body->>''source''=''plugin'' AND e=''session:update_availability'' THEN
      UPDATE public.crisp_workspaces SET last_presence_event_at=now() WHERE crisp_website_id=website;
    END IF;'||E'\n'||anchor);
  EXECUTE definition;
END $$;

-- Keep exhausted receipts for diagnosis/reconciliation instead of hiding them
-- as successfully processed. They cannot block the SKIP LOCKED event queue.
COMMENT ON COLUMN public.crisp_workspaces.visitor_identity_checked_at IS
  'Last successful REST identity read; not website arrival time or a complete absence proof.';
COMMENT ON COLUMN public.crisp_workspaces.last_presence_event_at IS
  'Last processed signed plugin availability event; absence of events is not a heartbeat.';
