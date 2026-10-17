-- Version matches the recorded Supabase MCP migration.
-- A durable hint survives a cached/empty read or an overlapping poll lease.
-- Three budgeted verification passes maximum; regular polling remains recovery.
ALTER TABLE public.crisp_site_arrivals
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX crisp_site_arrivals_pending_idx
  ON public.crisp_site_arrivals(crisp_website_id,next_attempt_at)
  WHERE verified_at IS NULL AND attempts<3;

DO $$
DECLARE definition text; anchor text;
BEGIN
  definition:=pg_get_functiondef('public.crisp_register_site_arrival(text,text,uuid)'::regprocedure);
  anchor:='INSERT INTO public.crisp_site_arrivals(crisp_website_id,crisp_session_id,request_id)
    VALUES(p_website_id,p_session_id,p_request_id)
    ON CONFLICT(crisp_website_id,crisp_session_id) DO UPDATE SET request_id=excluded.request_id,received_at=now();';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected arrival receipt definition'; END IF;
  definition:=replace(definition,anchor,'INSERT INTO public.crisp_site_arrivals(crisp_website_id,crisp_session_id,request_id,expires_at)
    VALUES(p_website_id,p_session_id,p_request_id,now()+interval ''30 seconds'')
    ON CONFLICT(crisp_website_id,crisp_session_id) DO UPDATE SET request_id=excluded.request_id,received_at=now(),
      attempts=0,verified_at=NULL,next_attempt_at=now(),expires_at=now()+interval ''30 seconds'';');
  EXECUTE definition;

  definition:=pg_get_functiondef('public.crisp_claim_presence(text)'::regprocedure);
  anchor:='w.site_presence_pending AND (w.site_presence_claimed_at IS NULL';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected accelerated claim definition'; END IF;
  definition:=replace(definition,anchor,'w.site_presence_pending AND EXISTS(
        SELECT 1 FROM public.crisp_site_arrivals a WHERE a.crisp_website_id=p_website_id
          AND a.verified_at IS NULL AND a.attempts<3 AND a.expires_at>now() AND a.next_attempt_at<=now())
        AND (w.site_presence_claimed_at IS NULL');
  EXECUTE definition;
END $$;

-- Private target list, not a public visitor lookup. Limit work per invocation.
CREATE FUNCTION public.crisp_pending_site_sessions(p_website_id text) RETURNS text[]
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
  SELECT coalesce(array_agg(crisp_session_id),'{}') FROM (
    SELECT crisp_session_id FROM public.crisp_site_arrivals
    WHERE crisp_website_id=p_website_id AND verified_at IS NULL AND attempts<3
      AND expires_at>now() AND next_attempt_at<=now()
    ORDER BY received_at LIMIT 20
  ) a;
$$;

CREATE FUNCTION public.crisp_finish_presence_v3(
  p_website_id text,p_token uuid,p_started_at timestamptz,p_rows jsonb,p_complete boolean,
  p_count integer,p_active integer,p_limited boolean,p_error text,p_requests integer,
  p_duration_ms integer,p_mode text,p_cached boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NOT public.crisp_finish_presence_v2(p_website_id,p_token,p_started_at,p_rows,p_complete,
    p_count,p_active,p_limited,p_error,p_requests,p_duration_ms,p_mode) THEN RETURN false; END IF;
  UPDATE public.crisp_site_arrivals a SET
    attempts=least(3,a.attempts+1),
    verified_at=CASE WHEN NOT coalesce(p_cached,true) AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r->>'crisp_session_id'=a.crisp_session_id)
      THEN now() ELSE NULL END,
    next_attempt_at=now()+interval '2 seconds'
  WHERE a.crisp_website_id=p_website_id AND a.verified_at IS NULL AND a.attempts<3
    AND a.expires_at>now() AND a.received_at<=p_started_at AND a.next_attempt_at<=p_started_at;
  UPDATE public.crisp_workspaces SET site_presence_pending=EXISTS(
    SELECT 1 FROM public.crisp_site_arrivals a WHERE a.crisp_website_id=p_website_id
      AND a.verified_at IS NULL AND a.attempts<3 AND a.expires_at>now())
    WHERE crisp_website_id=p_website_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.crisp_pending_site_sessions(text),
  public.crisp_finish_presence_v3(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text,integer,integer,text,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_pending_site_sessions(text),
  public.crisp_finish_presence_v3(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text,integer,integer,text,boolean)
  TO service_role;
