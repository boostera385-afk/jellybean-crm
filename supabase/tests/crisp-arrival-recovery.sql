BEGIN;
DO $$
DECLARE w text:=gen_random_uuid()::text; s text:='session_11111111-1111-4111-8111-111111111111';
 token uuid; i integer;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,greeting_worker_enabled)
    VALUES(w,'Arrival recovery regression',true,false);
  INSERT INTO public.crisp_site_bridges(crisp_website_id,origin,secret_id)
    VALUES(w,'https://example.com',gen_random_uuid());
  PERFORM public.crisp_register_site_arrival(w,s,gen_random_uuid());
  IF public.crisp_pending_site_sessions(w)<>ARRAY[s] THEN RAISE EXCEPTION 'Target lost'; END IF;
  token:=public.crisp_claim_presence(w);
  -- A cached identity is not fresh verification of an arrival.
  PERFORM public.crisp_finish_presence_v3(w,token,now(),jsonb_build_array(jsonb_build_object('crisp_session_id',s)),false,NULL,NULL,NULL,NULL,1,10,'identity',true);
  IF (SELECT verified_at IS NOT NULL FROM public.crisp_site_arrivals WHERE crisp_website_id=w) THEN
    RAISE EXCEPTION 'Cached arrival marked verified'; END IF;
  IF NOT (SELECT site_presence_pending FROM public.crisp_workspaces WHERE crisp_website_id=w) THEN
    RAISE EXCEPTION 'Cached read consumed unresolved hint'; END IF;
  UPDATE public.crisp_site_arrivals SET next_attempt_at=now() WHERE crisp_website_id=w;
  UPDATE public.crisp_workspaces SET site_presence_claimed_at=now()-interval '3 seconds' WHERE crisp_website_id=w;
  token:=public.crisp_claim_presence(w);
  IF token IS NULL THEN RAISE EXCEPTION 'Retry did not accelerate'; END IF;
  PERFORM public.crisp_finish_presence_v3(w,token,now(),jsonb_build_array(jsonb_build_object('crisp_session_id',s)),false,NULL,NULL,NULL,NULL,1,10,'identity',false);
  IF NOT EXISTS(SELECT 1 FROM public.crisp_site_arrivals WHERE crisp_website_id=w AND verified_at IS NOT NULL AND attempts=2) THEN
    RAISE EXCEPTION 'Fresh identity not verified'; END IF;
  IF (SELECT site_presence_pending FROM public.crisp_workspaces WHERE crisp_website_id=w) THEN
    RAISE EXCEPTION 'Verified arrival still pending'; END IF;
  -- Simulate a distinct later arrival, and exhaust the finite retry allowance.
  UPDATE public.crisp_site_arrivals SET received_at=now()-interval '3 minutes' WHERE crisp_website_id=w;
  PERFORM public.crisp_register_site_arrival(w,s,gen_random_uuid());
  FOR i IN 1..3 LOOP
    UPDATE public.crisp_site_arrivals SET next_attempt_at=now() WHERE crisp_website_id=w;
    UPDATE public.crisp_workspaces SET site_presence_claimed_at=now()-interval '3 seconds' WHERE crisp_website_id=w;
    token:=public.crisp_claim_presence(w);
    IF token IS NULL THEN RAISE EXCEPTION 'Retry lease missing at %',i; END IF;
    PERFORM public.crisp_finish_presence_v3(w,token,now(),'[]',false,NULL,NULL,NULL,NULL,1,10,'identity',false);
  END LOOP;
  IF (SELECT site_presence_pending FROM public.crisp_workspaces WHERE crisp_website_id=w) OR
    public.crisp_pending_site_sessions(w)<>'{}'::text[] OR public.crisp_claim_presence(w) IS NOT NULL THEN
    RAISE EXCEPTION 'Unbounded arrival retries'; END IF;
  UPDATE public.crisp_site_arrivals SET received_at=now()-interval '3 minutes' WHERE crisp_website_id=w;
  PERFORM public.crisp_register_site_arrival(w,s,gen_random_uuid());
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=w;
  token:=public.crisp_claim_presence(w);
  IF public.crisp_finish_presence_v3(w,gen_random_uuid(),now(),'[]',false,NULL,NULL,NULL,NULL,1,10,'identity',false) THEN
    RAISE EXCEPTION 'Stale lease applied to arrival'; END IF;
  -- The hint arrived after this read began; it must remain pending/untouched.
  PERFORM public.crisp_finish_presence_v3(w,token,now()-interval '1 second','[]',false,NULL,NULL,NULL,NULL,1,10,'identity',false);
  IF NOT EXISTS(SELECT 1 FROM public.crisp_site_arrivals WHERE crisp_website_id=w AND attempts=0 AND verified_at IS NULL) OR
    NOT (SELECT site_presence_pending FROM public.crisp_workspaces WHERE crisp_website_id=w) THEN
    RAISE EXCEPTION 'Concurrent new hint was consumed by an older read'; END IF;
  UPDATE public.crisp_site_arrivals SET expires_at=now()-interval '1 second' WHERE crisp_website_id=w;
  IF public.crisp_pending_site_sessions(w)<>'{}'::text[] OR public.crisp_claim_presence(w) IS NOT NULL THEN
    RAISE EXCEPTION 'Expired hint bypassed normal cadence'; END IF;
  IF has_function_privilege('anon','public.crisp_pending_site_sessions(text)','execute') THEN
    RAISE EXCEPTION 'Private arrival sessions exposed'; END IF;
  RAISE NOTICE 'Arrival recovery regression passed';
END $$;
ROLLBACK;
