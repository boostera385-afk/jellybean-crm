-- Fixtures roll back. No external requests or visitor presence assertions.
BEGIN;
DO $$
DECLARE w text:=gen_random_uuid()::text; token uuid; result text;
  s text:='session_11111111-1111-4111-8111-111111111111'; request uuid:=gen_random_uuid();
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,greeting_worker_enabled,auto_greet_enabled,auto_greet_message)
    VALUES(w,'Site bridge regression',true,true,true,'Hello');
  INSERT INTO public.crisp_site_bridges(crisp_website_id,origin,secret_id) VALUES(w,'https://example.com',gen_random_uuid());
  UPDATE public.crisp_workspaces SET visitor_synced_at=now() WHERE crisp_website_id=w;
  IF public.crisp_claim_presence(w) IS NOT NULL THEN RAISE EXCEPTION 'Normal cadence bypassed'; END IF;
  result:=public.crisp_register_site_arrival(w,s,request);
  IF result<>'accepted' THEN RAISE EXCEPTION 'Arrival not registered: %',result; END IF;
  IF EXISTS(SELECT 1 FROM public.crisp_visitors WHERE crisp_website_id=w) OR
    EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=w) THEN
    RAISE EXCEPTION 'Unverified arrival created presence/greeting'; END IF;
  IF public.crisp_register_site_arrival(w,s,request)<>'duplicate' OR
    public.crisp_register_site_arrival(w,s,gen_random_uuid())<>'duplicate' THEN RAISE EXCEPTION 'Duplicate not suppressed'; END IF;
  token:=public.crisp_claim_presence(w);
  IF token IS NULL THEN RAISE EXCEPTION 'Arrival did not expedite presence claim'; END IF;
  IF public.crisp_claim_presence(w) IS NOT NULL THEN RAISE EXCEPTION 'Active lease bypassed'; END IF;
  PERFORM public.crisp_finish_presence_v2(w,token,now(),jsonb_build_array(jsonb_build_object('crisp_session_id',s)),false,NULL,NULL,NULL,NULL,1,10,'identity');
  IF NOT EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=w AND crisp_session_id=s AND state='pending') THEN
    RAISE EXCEPTION 'Verified REST identity did not queue greeting'; END IF;
  UPDATE public.crisp_workspaces SET site_presence_pending=true WHERE crisp_website_id=w;
  IF public.crisp_claim_presence(w) IS NOT NULL THEN RAISE EXCEPTION 'Two-second acceleration cap bypassed'; END IF;
  UPDATE public.crisp_workspaces SET site_presence_claimed_at=now()-interval '5 seconds',crisp_cooldown_until=now()+interval '1 hour' WHERE crisp_website_id=w;
  IF public.crisp_claim_presence(w) IS NOT NULL THEN RAISE EXCEPTION 'Crisp cooldown bypassed'; END IF;
  UPDATE public.crisp_workspaces SET crisp_cooldown_until=NULL,presence_paused_until=now()+interval '1 hour' WHERE crisp_website_id=w;
  IF public.crisp_register_site_arrival(w,'session_22222222-2222-4222-8222-222222222222',gen_random_uuid())<>'disabled' OR
    public.crisp_claim_presence(w) IS NOT NULL THEN RAISE EXCEPTION 'Paused workspace reenabled'; END IF;
  UPDATE public.crisp_workspaces SET presence_paused_until=NULL WHERE crisp_website_id=w;
  UPDATE public.crisp_site_bridges SET minute_count=20,minute_at=now() WHERE crisp_website_id=w;
  IF public.crisp_register_site_arrival(w,'session_22222222-2222-4222-8222-222222222222',gen_random_uuid())<>'limited' THEN
    RAISE EXCEPTION 'Atomic site limit bypassed'; END IF;
  IF has_function_privilege('anon','public.crisp_get_site_bridge(text)','execute') OR
    has_function_privilege('authenticated','public.crisp_provision_site_bridge(text,text,text)','execute') OR
    has_function_privilege('anon','public.crisp_register_site_arrival(text,text,uuid)','execute') OR
    has_table_privilege('anon','public.crisp_site_bridges','select') THEN RAISE EXCEPTION 'Bridge credentials exposed'; END IF;
  RAISE NOTICE 'Site bridge regression checks passed';
END $$;
ROLLBACK;
