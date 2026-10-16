-- Count-tripwire reconciliation: faster arrival detection on the same budget.
--
-- Evidence (measured 2026-10-16): passive arrivals are only visible to REST
-- polling because Crisp Website Hooks deliver zero availability events (0 in
-- 48h). The 20s claim guard therefore set the floor at ~10s average
-- detection (guard halves on average), with greeting send itself at 0.34s p50.
-- A plain faster count+list cadence is impossible on the Website-token quota:
-- 10s costs ~17k calls/day against a 9,000/day background budget.
--
-- Cheaper tripwire instead: claim at a 12s interval, fetch ONLY
-- visitors/count, and skip the list pages whenever Crisp's count equals the
-- online rows we already hold AND a complete list pass happened within the
-- last 55s (the UI staleness banner keys on visitor_sync_succeeded_at with a
-- 60s window, so a complete snapshot must be no older than that). A mismatch
-- (someone arrived or left) or an expired full pass triggers the full list
-- reconciliation in the SAME cycle, so arrivals land ~6s on average at
-- ~7,200 + ~1,560 calls/day worst case versus 8,640/day spent before.

ALTER TABLE public.crisp_workspaces
  ADD COLUMN IF NOT EXISTS last_full_presence_at timestamptz;

CREATE OR REPLACE FUNCTION public.crisp_finish_presence(p_website_id text,p_token uuid,p_started_at timestamptz,
  p_rows jsonb,p_complete boolean,p_count integer,p_active integer,p_limited boolean,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND visitor_sync_lease=p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_error IS NULL OR jsonb_array_length(p_rows)>0 THEN
    INSERT INTO public.crisp_visitors(crisp_website_id,crisp_session_id,nickname,email,avatar,user_agent,initiated,
      active,is_online,last_page_title,last_page_url,country,region,city,latitude,longitude,timezone_minutes,
      capabilities,locales,last_online_at,last_seen_at,presence_observed_at,updated_at)
    SELECT p_website_id,r.crisp_session_id,r.nickname,r.email,r.avatar,r.user_agent,coalesce(r.initiated,false),
      coalesce(r.active,false),true,r.last_page_title,r.last_page_url,r.country,r.region,r.city,r.latitude,r.longitude,r.timezone_minutes,
      coalesce(r.capabilities,'{}'),coalesce(r.locales,'{}'),p_started_at,p_started_at,p_started_at,now()
    FROM jsonb_to_recordset(p_rows) AS r(crisp_session_id text,nickname text,email text,avatar text,user_agent text,initiated boolean,
      active boolean,last_page_title text,last_page_url text,country text,region text,city text,latitude float8,longitude float8,
      timezone_minutes integer,capabilities text[],locales text[])
    WHERE r.crisp_session_id IS NOT NULL
    ON CONFLICT(crisp_website_id,crisp_session_id) DO UPDATE SET
      nickname=coalesce(EXCLUDED.nickname,public.crisp_visitors.nickname),email=coalesce(EXCLUDED.email,public.crisp_visitors.email),
      avatar=coalesce(EXCLUDED.avatar,public.crisp_visitors.avatar),user_agent=coalesce(EXCLUDED.user_agent,public.crisp_visitors.user_agent),
      initiated=public.crisp_visitors.initiated OR EXCLUDED.initiated,active=EXCLUDED.active,is_online=true,
      last_page_title=coalesce(EXCLUDED.last_page_title,public.crisp_visitors.last_page_title),
      last_page_url=coalesce(EXCLUDED.last_page_url,public.crisp_visitors.last_page_url),
      country=coalesce(EXCLUDED.country,public.crisp_visitors.country),region=coalesce(EXCLUDED.region,public.crisp_visitors.region),
      city=coalesce(EXCLUDED.city,public.crisp_visitors.city),latitude=coalesce(EXCLUDED.latitude,public.crisp_visitors.latitude),
      longitude=coalesce(EXCLUDED.longitude,public.crisp_visitors.longitude),timezone_minutes=coalesce(EXCLUDED.timezone_minutes,public.crisp_visitors.timezone_minutes),
      capabilities=EXCLUDED.capabilities,locales=EXCLUDED.locales,last_online_at=p_started_at,last_seen_at=p_started_at,
      presence_observed_at=p_started_at,updated_at=now()
    WHERE coalesce(public.crisp_visitors.presence_observed_at,'-infinity') <= p_started_at;
    IF p_error IS NULL AND p_complete AND NOT p_limited THEN
      UPDATE public.crisp_visitors v SET is_online=false,active=false,presence_observed_at=p_started_at,updated_at=now()
      WHERE v.crisp_website_id=p_website_id AND v.is_online AND coalesce(v.presence_observed_at,'-infinity') <= p_started_at
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r->>'crisp_session_id'=v.crisp_session_id);
    END IF;
    INSERT INTO public.crisp_visitor_daily_visits(crisp_website_id,crisp_session_id,visit_date,last_seen_at)
      SELECT p_website_id,r->>'crisp_session_id',(p_started_at AT TIME ZONE 'Asia/Karachi')::date,p_started_at
      FROM jsonb_array_elements(p_rows) r WHERE r->>'crisp_session_id' IS NOT NULL
      ON CONFLICT(crisp_website_id,crisp_session_id,visit_date) DO UPDATE SET last_seen_at=greatest(public.crisp_visitor_daily_visits.last_seen_at,EXCLUDED.last_seen_at),updated_at=now();
  END IF;
  UPDATE public.crisp_workspaces SET visitor_sync_lease=NULL,visitor_sync_lease_until=NULL,
    visitor_sync_error=p_error,visitor_sync_succeeded_at=CASE WHEN p_error IS NULL AND p_complete THEN now() ELSE visitor_sync_succeeded_at END,
    -- Only a complete snapshot refreshes the tripwire's full-pass watermark.
    last_full_presence_at=CASE WHEN p_error IS NULL AND p_complete THEN now() ELSE last_full_presence_at END,
    live_visitor_count=CASE WHEN p_error IS NULL THEN coalesce(p_count,jsonb_array_length(p_rows)) ELSE live_visitor_count END,
    active_visitor_count=CASE WHEN p_error IS NULL THEN coalesce(p_active,active_visitor_count) ELSE active_visitor_count END,
    visitors_limited=CASE WHEN p_error IS NULL THEN p_limited ELSE visitors_limited END
    WHERE crisp_website_id=p_website_id;
  RETURN true;
END; $$;

REVOKE ALL ON FUNCTION public.crisp_finish_presence(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_finish_presence(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text) TO service_role;

-- Adopt the cheaper cadence. Per-workspace knobs from 20261015120000 are live,
-- so this can be tuned per workspace later without another migration.
UPDATE public.crisp_workspaces SET visitor_sync_interval_seconds=12 WHERE enabled;
