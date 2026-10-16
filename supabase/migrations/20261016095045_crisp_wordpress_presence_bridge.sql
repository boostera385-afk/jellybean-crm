-- Signed WordPress arrivals are acceleration hints, never presence evidence.
-- Filename matches the recorded Supabase MCP migration version.
-- Only a budgeted Crisp REST identity read may update visitors / queue greetings.
ALTER TABLE public.crisp_workspaces
  ADD COLUMN site_presence_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN site_presence_requested_at timestamptz,
  ADD COLUMN site_presence_claimed_at timestamptz;

CREATE TABLE public.crisp_site_bridges (
  crisp_website_id text PRIMARY KEY REFERENCES public.crisp_workspaces(crisp_website_id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),
  secret_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  minute_at timestamptz NOT NULL DEFAULT now(),
  minute_count integer NOT NULL DEFAULT 0,
  hour_at timestamptz NOT NULL DEFAULT now(),
  hour_count integer NOT NULL DEFAULT 0,
  last_received_at timestamptz
);
CREATE TABLE public.crisp_site_arrivals (
  crisp_website_id text NOT NULL REFERENCES public.crisp_site_bridges(crisp_website_id) ON DELETE CASCADE,
  crisp_session_id text NOT NULL CHECK (crisp_session_id ~ '^session_[0-9a-f-]{36}$'),
  request_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crisp_website_id, crisp_session_id)
);
CREATE INDEX crisp_site_arrivals_received_idx ON public.crisp_site_arrivals(received_at);
ALTER TABLE public.crisp_site_bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crisp_site_arrivals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crisp_site_bridges, public.crisp_site_arrivals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.crisp_site_bridges, public.crisp_site_arrivals TO service_role;

-- Provisioning is an operations action. Keys are unique per website and must
-- reach the WordPress administrator through a password manager, not the ZIP.
CREATE FUNCTION public.crisp_provision_site_bridge(p_website_id text, p_origin text, p_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sid uuid;
BEGIN
  IF p_origin IS NULL OR p_key IS NULL OR p_origin !~ '^https://[a-z0-9.-]+(:[0-9]+)?$' OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'HTTPS origin and a random 256-bit key required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND enabled
    AND (presence_paused_until IS NULL OR presence_paused_until<=now())) THEN
    RAISE EXCEPTION 'Workspace disabled, paused, or missing';
  END IF;
  SELECT secret_id INTO sid FROM public.crisp_site_bridges WHERE crisp_website_id=p_website_id FOR UPDATE;
  IF sid IS NULL THEN
    sid:=vault.create_secret(p_key,'crisp_site_bridge_'||p_website_id,'WordPress presence relay key');
  ELSE
    PERFORM vault.update_secret(sid,p_key);
  END IF;
  INSERT INTO public.crisp_site_bridges(crisp_website_id,origin,secret_id)
    VALUES(p_website_id,p_origin,sid)
    ON CONFLICT(crisp_website_id) DO UPDATE SET origin=excluded.origin,enabled=true;
END $$;

CREATE FUNCTION public.crisp_get_site_bridge(p_website_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object('origin',b.origin,'key',s.decrypted_secret)
  FROM public.crisp_site_bridges b JOIN vault.decrypted_secrets s ON s.id=b.secret_id
  JOIN public.crisp_workspaces w USING(crisp_website_id)
  WHERE b.crisp_website_id=p_website_id AND b.enabled AND w.enabled
    AND (w.presence_paused_until IS NULL OR w.presence_paused_until<=now());
$$;

CREATE FUNCTION public.crisp_register_site_arrival(p_website_id text,p_session_id text,p_request_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE b public.crisp_site_bridges; a public.crisp_site_arrivals;
BEGIN
  IF p_session_id IS NULL OR p_session_id !~ '^session_[0-9a-f-]{36}$' OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Invalid arrival';
  END IF;
  -- Serialize all arrivals for one website; no anonymous/public RPC access.
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND enabled
    AND (presence_paused_until IS NULL OR presence_paused_until<=now()) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'disabled'; END IF;
  SELECT * INTO b FROM public.crisp_site_bridges WHERE crisp_website_id=p_website_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN 'disabled'; END IF;
  SELECT * INTO a FROM public.crisp_site_arrivals WHERE crisp_website_id=p_website_id AND crisp_session_id=p_session_id;
  IF FOUND AND (a.request_id=p_request_id OR a.received_at>now()-interval '2 minutes') THEN RETURN 'duplicate'; END IF;
  IF date_trunc('minute',b.minute_at)<>date_trunc('minute',now()) THEN b.minute_count:=0; END IF;
  IF date_trunc('hour',b.hour_at)<>date_trunc('hour',now()) THEN b.hour_count:=0; END IF;
  IF b.minute_count>=20 OR b.hour_count>=200 THEN RETURN 'limited'; END IF;
  UPDATE public.crisp_site_bridges SET minute_at=now(),minute_count=b.minute_count+1,
    hour_at=now(),hour_count=b.hour_count+1,last_received_at=now() WHERE crisp_website_id=p_website_id;
  INSERT INTO public.crisp_site_arrivals(crisp_website_id,crisp_session_id,request_id)
    VALUES(p_website_id,p_session_id,p_request_id)
    ON CONFLICT(crisp_website_id,crisp_session_id) DO UPDATE SET request_id=excluded.request_id,received_at=now();
  UPDATE public.crisp_workspaces SET site_presence_pending=true,site_presence_requested_at=now()
    WHERE crisp_website_id=p_website_id;
  RETURN 'accepted';
END $$;

-- Keep the existing RPC and leases. One authenticated hint can bypass the
-- adaptive poll interval, but not the breaker, quota reserve or active lease.
DO $$
DECLARE definition text; anchor text;
BEGIN
  definition:=pg_get_functiondef('public.crisp_claim_presence(text)'::regprocedure);
  anchor:='IF w.visitor_synced_at IS NOT NULL AND w.visitor_synced_at>now()-make_interval(secs=>gap) THEN RETURN NULL; END IF;';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected presence claim definition'; END IF;
  definition:=replace(definition,anchor,
    'IF w.visitor_synced_at IS NOT NULL AND w.visitor_synced_at>now()-make_interval(secs=>gap)
      AND NOT (w.site_presence_pending AND (w.site_presence_claimed_at IS NULL OR w.site_presence_claimed_at<=now()-interval ''2 seconds''))
      THEN RETURN NULL; END IF;');
  anchor:='visitor_effective_interval_seconds=gap,visitor_budget_used=used';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Unexpected presence claim update'; END IF;
  definition:=replace(definition,anchor,anchor||',
    site_presence_claimed_at=CASE WHEN w.site_presence_pending THEN now() ELSE site_presence_claimed_at END,
    site_presence_pending=false');
  EXECUTE definition;
END $$;

REVOKE ALL ON FUNCTION public.crisp_provision_site_bridge(text,text,text),public.crisp_get_site_bridge(text),
  public.crisp_register_site_arrival(text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_provision_site_bridge(text,text,text),public.crisp_get_site_bridge(text),
  public.crisp_register_site_arrival(text,text,uuid) TO service_role;

-- Session IDs are retained only for short-lived duplicate suppression.
SELECT cron.schedule('crisp-site-arrival-cleanup','17 3 * * *',
  $job$DELETE FROM public.crisp_site_arrivals WHERE received_at<now()-interval '7 days'$job$);
