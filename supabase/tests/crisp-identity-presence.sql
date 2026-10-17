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
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>2 THEN
    RAISE EXCEPTION 'Replacement/legacy greeting not queued exactly once'; END IF;
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
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>2 THEN
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

-- Revisit greetings: a returning visitor is politely greeted again, but never
-- spammed within one visit and never re-greeted after actually replying.
DO $$
DECLARE rw text:='revisit-test-'||gen_random_uuid(); token uuid;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,auto_greet_enabled,auto_greet_message,greeting_worker_enabled)
    VALUES(rw,'Revisit regression',true,true,'Hello',true);
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=rw
    AND auto_greet_revisit_enabled AND auto_greet_revisit_after_seconds=1800
    AND nullif(trim(coalesce(auto_greet_revisit_message,'')),'') IS NOT NULL) THEN
    RAISE EXCEPTION 'Revisit defaults missing'; END IF;
  token:=public.crisp_claim_presence(rw);
  PERFORM public.crisp_finish_presence_v2(rw,token,now()-interval '8 hours','[{"crisp_session_id":"v1","nickname":"Sam"}]',true,1,1,false,NULL,1,20,'full');
  IF NOT EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=rw AND crisp_session_id='v1'
    AND state='pending' AND is_revisit=false AND content='Hello') THEN
    RAISE EXCEPTION 'First greeting changed'; END IF;
   -- Say the first greeting was delivered 7 hours ago; continuous presence is NOT a return.
  UPDATE public.crisp_greeting_jobs SET state='sent',sent_at=now()-interval '7 hours' WHERE crisp_website_id=rw AND crisp_session_id='v1';
  ALTER TABLE public.crisp_visitors DISABLE TRIGGER crisp_enqueue_greeting;
   UPDATE public.crisp_visitors SET auto_greeted_at=now()-interval '7 hours' WHERE crisp_website_id=rw AND crisp_session_id='v1';
  ALTER TABLE public.crisp_visitors ENABLE TRIGGER crisp_enqueue_greeting;
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=rw;
  token:=public.crisp_claim_presence(rw);
  PERFORM public.crisp_finish_presence_v2(rw,token,now(),'[{"crisp_session_id":"v1","nickname":"Sam"}]',true,1,1,false,NULL,1,20,'full');
  IF EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=rw AND state='pending') THEN
    RAISE EXCEPTION 'Continuous visit was greeted again after cooldown'; END IF;
  -- A validated departure followed by >=2 minutes away establishes a new visit.
  UPDATE public.crisp_visitors SET is_online=false,presence_observed_at=now()-interval '3 minutes'
    WHERE crisp_website_id=rw AND crisp_session_id='v1';
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=rw;
  token:=public.crisp_claim_presence(rw);
  PERFORM public.crisp_finish_presence_v2(rw,token,now(),'[{"crisp_session_id":"v1","nickname":"Sam"}]',true,1,1,false,NULL,1,20,'full');
  IF NOT EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=rw AND crisp_session_id='v1'
    AND state='pending' AND is_revisit=true AND content LIKE 'Welcome back%') THEN
    RAISE EXCEPTION 'Returning visitor was not greeted again'; END IF;
   -- Inside the cooldown window a returning visitor is NOT greeted again.
  UPDATE public.crisp_greeting_jobs SET state='sent',sent_at=now() WHERE crisp_website_id=rw AND crisp_session_id='v1' AND is_revisit;
  ALTER TABLE public.crisp_visitors DISABLE TRIGGER crisp_enqueue_greeting;
  UPDATE public.crisp_visitors SET auto_greeted_at=now()-interval '15 minutes' WHERE crisp_website_id=rw AND crisp_session_id='v1';
  ALTER TABLE public.crisp_visitors ENABLE TRIGGER crisp_enqueue_greeting;
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=rw;
  token:=public.crisp_claim_presence(rw);
  PERFORM public.crisp_finish_presence_v2(rw,token,now(),'[{"crisp_session_id":"v1","nickname":"Sam"}]',true,1,1,false,NULL,1,20,'full');
  IF EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=rw AND crisp_session_id='v1'
    AND state IN ('pending','leased','sending')) THEN
    RAISE EXCEPTION 'Cooldown did not suppress a repeat greeting'; END IF;
  -- A visitor who actually replied is a human lead: never re-greeted.
  ALTER TABLE public.crisp_visitors DISABLE TRIGGER crisp_enqueue_greeting;
  UPDATE public.crisp_visitors SET auto_greeted_at=now()-interval '7 hours' WHERE crisp_website_id=rw AND crisp_session_id='v1';
  ALTER TABLE public.crisp_visitors ENABLE TRIGGER crisp_enqueue_greeting;
  INSERT INTO public.crisp_conversations(crisp_website_id,crisp_session_id,last_message,last_message_at)
    VALUES(rw,'v1','What does it cost?',now()-interval '7 hours');
  INSERT INTO public.crisp_messages(conversation_id,crisp_website_id,crisp_session_id,crisp_message_id,sender_type,direction,content,message_type,sent_at)
    SELECT id,rw,'v1','cust-1','customer','incoming','What does it cost?','text',now()-interval '7 hours'
    FROM public.crisp_conversations WHERE crisp_website_id=rw AND crisp_session_id='v1';
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=rw;
  token:=public.crisp_claim_presence(rw);
  PERFORM public.crisp_finish_presence_v2(rw,token,now(),'[{"crisp_session_id":"v1","nickname":"Sam"}]',true,1,1,false,NULL,1,20,'full');
  IF EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=rw AND crisp_session_id='v1'
    AND state IN ('pending','leased','sending') AND created_at>now()-interval '1 minute') THEN
    RAISE EXCEPTION 'Bot re-greeted a visitor who replied'; END IF;
  -- First-greet rule intact: an operator conversation silences the first greeting.
  INSERT INTO public.crisp_conversations(crisp_website_id,crisp_session_id,last_message,last_message_at)
    VALUES(rw,'v2','Operator hello',now());
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=rw;
  token:=public.crisp_claim_presence(rw);
  PERFORM public.crisp_finish_presence_v2(rw,token,now(),'[{"crisp_session_id":"v2"}]',true,2,2,false,NULL,1,20,'full');
  IF EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=rw AND crisp_session_id='v2') THEN
    RAISE EXCEPTION 'Operator conversation no longer blocks the bot'; END IF;
  -- Pre-pipeline returning visitor (first_seen before pipeline_started_at, never
  -- greeted): must be greeted on return now that the cutover gate is gone.
  INSERT INTO public.crisp_visitors(crisp_website_id,crisp_session_id,is_online,first_seen_at)
    VALUES(rw,'legacy',false,now()-interval '2 hours');
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=rw;
  token:=public.crisp_claim_presence(rw);
  PERFORM public.crisp_finish_presence_v2(rw,token,now(),'[{"crisp_session_id":"legacy"}]',true,3,3,false,NULL,1,20,'full');
  IF NOT EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=rw AND crisp_session_id='legacy'
    AND state='pending' AND is_revisit=false AND content='Hello' AND expires_at>now()) THEN
    RAISE EXCEPTION 'Pre-pipeline returning visitor still blocked'; END IF;
  RAISE NOTICE 'Revisit greeting checks passed';
END $$;

-- 404/403 breaker: persistent not-found pauses polling; success restores counts.
DO $$
DECLARE w text:='continuous-test-'||gen_random_uuid(); token uuid;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,greeting_worker_enabled,auto_greet_enabled)
    VALUES(w,'Continuous visit regression',true,true,true);
  INSERT INTO public.crisp_visitors(crisp_website_id,crisp_session_id,is_online,auto_greeted_at,presence_observed_at)
    VALUES(w,'long-visit',false,now()-interval '2 hours',now()-interval '3 hours');
  token:=public.crisp_claim_presence(w);
  PERFORM public.crisp_finish_presence_v2(w,token,now()-interval '1 hour','[{"crisp_session_id":"long-visit"}]',false,NULL,NULL,NULL,NULL,1,10,'identity');
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>1 THEN
    RAISE EXCEPTION 'Verified returning visit not queued'; END IF;
  UPDATE public.crisp_greeting_jobs SET state='sent',sent_at=now()-interval '59 minutes' WHERE crisp_website_id=w;
  UPDATE public.crisp_visitors SET auto_greeted_at=now()-interval '59 minutes' WHERE crisp_website_id=w;
  UPDATE public.crisp_visitors SET nickname='metadata change' WHERE crisp_website_id=w;
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=w;
  token:=public.crisp_claim_presence(w);
  PERFORM public.crisp_finish_presence_v2(w,token,now(),'[{"crisp_session_id":"long-visit"}]',false,NULL,NULL,NULL,NULL,1,10,'identity');
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>1 THEN
    RAISE EXCEPTION 'Long continuous visit re-greeted after cooldown'; END IF;
  UPDATE public.crisp_visitors SET is_online=false,presence_observed_at=now()-interval '1 minute' WHERE crisp_website_id=w;
  UPDATE public.crisp_visitors SET is_online=true,presence_observed_at=now() WHERE crisp_website_id=w;
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>1 THEN
    RAISE EXCEPTION 'Brief presence flap re-greeted'; END IF;
  UPDATE public.crisp_visitors SET is_online=false,presence_observed_at=now()-interval '3 minutes' WHERE crisp_website_id=w;
  UPDATE public.crisp_visitors SET is_online=true,presence_observed_at=now() WHERE crisp_website_id=w;
  IF (SELECT count(*) FROM public.crisp_greeting_jobs WHERE crisp_website_id=w)<>2 THEN
    RAISE EXCEPTION 'Next genuine visit not greeted'; END IF;
END $$;

-- 404/403 breaker: persistent not-found pauses polling; success restores counts.
DO $$
DECLARE bw text:='breaker-test-'||gen_random_uuid(); token uuid; i integer;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,greeting_worker_enabled)
    VALUES(bw,'Breaker regression',true,false);
  FOR i IN 1..10 LOOP
    UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=bw;
    token:=public.crisp_claim_presence(bw);
    IF token IS NULL THEN RAISE EXCEPTION 'Breaker claimed too early at %', i; END IF;
    PERFORM public.crisp_finish_presence_v2(bw,token,now(),'[]',false,NULL,NULL,NULL,'Visitor count HTTP 404',1,10,'full');
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=bw
    AND presence_failure_count=10 AND presence_paused_until>now()
    AND presence_paused_reason LIKE '%404%') THEN
    RAISE EXCEPTION 'Presence breaker did not trip after repeated 404'; END IF;
  IF public.crisp_claim_presence(bw) IS NOT NULL THEN
    RAISE EXCEPTION 'Paused workspace still polling'; END IF;
  -- Transient 5xx errors must never trip the breaker.
  UPDATE public.crisp_workspaces SET presence_paused_until=NULL,visitor_synced_at=NULL WHERE crisp_website_id=bw;
  FOR i IN 1..10 LOOP
    UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=bw;
    token:=public.crisp_claim_presence(bw);
    IF token IS NULL THEN RAISE EXCEPTION 'Claim blocked during 5xx'; END IF;
    PERFORM public.crisp_finish_presence_v2(bw,token,now(),'[]',false,NULL,NULL,NULL,'Visitor list HTTP 502',1,10,'identity');
  END LOOP;
  IF (SELECT presence_paused_until FROM public.crisp_workspaces WHERE crisp_website_id=bw) IS NOT NULL THEN
    RAISE EXCEPTION '5xx responses tripped the breaker'; END IF;
  -- A healthy pass resets the failure counter.
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=bw;
  token:=public.crisp_claim_presence(bw);
  PERFORM public.crisp_finish_presence_v2(bw,token,now(),'[{"crisp_session_id":"back"}]',true,1,1,false,NULL,1,20,'full');
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=bw AND presence_failure_count=0) THEN
    RAISE EXCEPTION 'Healthy pass did not reset the breaker counter'; END IF;
  RAISE NOTICE 'Presence breaker checks passed';
END $$;

-- Unmatched read receipts complete instead of dead-lettering the queue.
DO $$
DECLARE rw text:='receipt-test-'||gen_random_uuid(); token uuid; applied boolean;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,greeting_worker_enabled)
    VALUES(rw,'Receipt regression',true,false);
  BEGIN
    PERFORM public.crisp_apply_event(jsonb_build_object('website_id',rw,'event','message:acknowledge:read:received',
      'data',jsonb_build_object('session_id','s1','fingerprints',jsonb_build_array('999999999'))));
    applied := true;
  EXCEPTION WHEN OTHERS THEN
    applied := false;
  END;
  IF NOT applied THEN RAISE EXCEPTION 'Unmatched receipt still dead-letters'; END IF;
  RAISE NOTICE 'Receipt handling checks passed';
END $$;
ROLLBACK;
