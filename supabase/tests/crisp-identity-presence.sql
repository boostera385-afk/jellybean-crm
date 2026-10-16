-- Production-safe fixtures: no HTTP requests, all mutations rolled back.
BEGIN;
DO $$
DECLARE w text:='identity-test-'||gen_random_uuid(); token uuid; before_full timestamptz;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,auto_greet_enabled,auto_greet_message,greeting_worker_enabled)
    VALUES(w,'Identity regression',true,true,'Hello',true);
  INSERT INTO public.crisp_visitors(crisp_website_id,crisp_session_id,is_online,first_seen_at)
    VALUES(w,'old',true,now()-interval '1 day');
  token:=public.crisp_claim_presence(w);
  IF token IS NULL THEN RAISE EXCEPTION 'Initial claim failed'; END IF;
  PERFORM public.crisp_finish_presence_v2(w,token,now(),'[{"crisp_session_id":"replacement"}]',false,NULL,NULL,NULL,NULL,1,50,'identity');
  IF NOT EXISTS(SELECT 1 FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='replacement' AND is_online) THEN
    RAISE EXCEPTION 'Replacement arrival lost'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='old' AND is_online) THEN
    RAISE EXCEPTION 'Identity-only pass established absence'; END IF;
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>1 THEN
    RAISE EXCEPTION 'Replacement greeting not queued exactly once'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=w AND visitor_identity_checked_at IS NOT NULL AND last_full_presence_at IS NULL AND visitor_sync_succeeded_at IS NULL AND NOT visitors_limited) THEN
    RAISE EXCEPTION 'Identity/full freshness confused'; END IF;
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=w;
  token:=public.crisp_claim_presence(w);
  PERFORM public.crisp_finish_presence_v2(w,token,now(),'[{"crisp_session_id":"replacement"}]',true,1,1,false,NULL,2,60,'full');
  SELECT last_full_presence_at INTO before_full FROM public.crisp_workspaces WHERE crisp_website_id=w;
  IF before_full IS NULL THEN RAISE EXCEPTION 'Full snapshot not recorded'; END IF;
  UPDATE public.crisp_workspaces SET last_full_presence_at=now()-interval '2 minutes' WHERE crisp_website_id=w;
  SELECT last_full_presence_at INTO before_full FROM public.crisp_workspaces WHERE crisp_website_id=w;
  IF (SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='old') THEN
    RAISE EXCEPTION 'Validated full snapshot did not clear departure'; END IF;
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=w;
  token:=public.crisp_claim_presence(w);
  PERFORM public.crisp_finish_presence_v2(w,token,now(),'[]',true,0,0,true,NULL,1,40,'full');
  IF NOT (SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='replacement') THEN
    RAISE EXCEPTION 'Limited count erased live visitor'; END IF;
  IF (SELECT last_full_presence_at FROM public.crisp_workspaces WHERE crisp_website_id=w) IS DISTINCT FROM before_full THEN
    RAISE EXCEPTION 'Limited result refreshed full watermark'; END IF;
  IF public.crisp_finish_presence_v2(w,gen_random_uuid(),now(),'[]',true,0,0,false,NULL,1,0,'full') THEN
    RAISE EXCEPTION 'Stale lease accepted'; END IF;
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>1 THEN
    RAISE EXCEPTION 'Greeting duplicated'; END IF;
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=w;
  INSERT INTO public.crisp_api_usage VALUES(w,date_trunc('hour',now()),8200);
  token:=public.crisp_claim_presence(w);
  IF (SELECT visitor_effective_interval_seconds FROM public.crisp_workspaces WHERE crisp_website_id=w)<60 THEN
    RAISE EXCEPTION 'Budget pressure did not slow background polling'; END IF;
  IF public.crisp_claim_presence(w) IS NOT NULL THEN RAISE EXCEPTION 'Overlapping claim accepted'; END IF;
  IF has_function_privilege('authenticated','public.crisp_finish_presence_v2(text,uuid,timestamptz,jsonb,boolean,integer,integer,boolean,text,integer,integer,text)','execute') THEN
    RAISE EXCEPTION 'Client can mutate presence'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:update_availability','source','plugin',
    'data',jsonb_build_object('session_id','signed-arrival','availability','online')));
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=w AND last_presence_event_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Signed arrival provenance not recorded'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=w AND crisp_session_id='signed-arrival' AND state='pending') THEN
    RAISE EXCEPTION 'Signed arrival did not queue a greeting immediately'; END IF;
  RAISE NOTICE 'Identity presence checks passed';
END $$;
ROLLBACK;
