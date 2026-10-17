-- No HTTP calls and no permanent rows. Can run against a local test database
-- or a migrated project. All fixtures are rolled back.
BEGIN;
DO $$
DECLARE w text := 'pipeline-test-'||gen_random_uuid(); token uuid; job public.crisp_greeting_jobs;
  n integer; observed timestamptz:=now(); payload jsonb; x boolean;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name,enabled,auto_greet_enabled,auto_greet_message,greeting_worker_enabled)
    VALUES(w,'Pipeline test',false,true,'Hello there',true);
  IF public.claim_crisp_visitor_sync(w,now()) THEN RAISE EXCEPTION 'Legacy greeting sender active after cutover'; END IF;
  IF has_function_privilege('anon','public.claim_crisp_visitor_sync(text,timestamptz)','execute') THEN RAISE EXCEPTION 'Anonymous presence claim'; END IF;
  IF has_function_privilege('authenticated','public.crisp_reserve_request(text,boolean)','execute') THEN RAISE EXCEPTION 'Public budget mutation'; END IF;
  -- Greeting starts disabled so this pre-existing session is not backfilled;
  -- once enabled, revisiting visitors (old or new) are greeted by the trigger.
  INSERT INTO public.crisp_visitors(crisp_website_id,crisp_session_id,is_online,first_seen_at) VALUES(w,'old',true,now()-interval '1 day');
  IF EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE crisp_website_id=w) THEN RAISE EXCEPTION 'Historical greeting backfill'; END IF;
  UPDATE public.crisp_workspaces SET enabled=true WHERE crisp_website_id=w;
  payload:=jsonb_build_object('website_id',w,'event','session:sync:network','timestamp',(extract(epoch from now())*1000)::bigint,
    'data',jsonb_build_object('session_id','new','nickname','Tester'));
  PERFORM public.crisp_accept_event(payload,'test-'||w);
  PERFORM public.crisp_accept_event(payload,'test-'||w);
  SELECT count(*) INTO n FROM public.crisp_webhook_events WHERE crisp_website_id=w;
  IF n<>1 THEN RAISE EXCEPTION 'Event deduplication failed'; END IF;
  PERFORM public.crisp_process_events(w);
  IF EXISTS(SELECT 1 FROM public.crisp_webhook_events WHERE crisp_website_id=w AND NOT processed) THEN
    RAISE EXCEPTION 'Event failed: %',(SELECT error FROM public.crisp_webhook_events WHERE crisp_website_id=w LIMIT 1); END IF;
  -- A webhook arrival must raise the stored live counter immediately, before any
  -- REST reconciliation runs ('old' + 'new' are both online here).
  IF (SELECT live_visitor_count FROM public.crisp_workspaces WHERE crisp_website_id=w)<>2 THEN
    RAISE EXCEPTION 'Arrival did not raise live counter from webhook event'; END IF;
  SELECT * INTO job FROM public.crisp_claim_greetings(w);
  IF job.content<>'Hello there' THEN RAISE EXCEPTION 'Template/job creation failed'; END IF;
  IF NOT public.crisp_begin_greeting(job.id,job.lease_token) THEN RAISE EXCEPTION 'Send claim failed'; END IF;
  PERFORM public.crisp_complete_greeting(job.id,job.lease_token,'uncertain',NULL,'Lost response');
  SELECT count(*) INTO n FROM public.crisp_claim_greetings(w);
  IF n<>0 THEN RAISE EXCEPTION 'Ambiguous send retried'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','message:received','timestamp',(extract(epoch from now()-interval '900 milliseconds')*1000)::bigint,
    'data',jsonb_build_object('session_id','new','from','operator','fingerprint','out-1','content','Hello there')));
  IF NOT EXISTS(SELECT 1 FROM public.crisp_greeting_jobs WHERE id=job.id AND state='sent' AND external_fingerprint='out-1') THEN RAISE EXCEPTION 'Outgoing confirmation failed'; END IF;
  payload:=jsonb_build_object('website_id',w,'event','message:send','timestamp',(extract(epoch from now())*1000)::bigint,
    'data',jsonb_build_object('session_id','new','from','user','fingerprint','in-1','content','Need help'));
  PERFORM public.crisp_apply_event(payload); PERFORM public.crisp_apply_event(payload);
  IF (SELECT unread_count FROM public.crisp_conversations WHERE crisp_website_id=w AND crisp_session_id='new')<>1 THEN RAISE EXCEPTION 'Unread dedup failed'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','message:notify:unread:received','data',jsonb_build_object('session_id','new','from','operator')));
  IF (SELECT unread_count FROM public.crisp_conversations WHERE crisp_website_id=w AND crisp_session_id='new')<>1 THEN RAISE EXCEPTION 'Control event rewrote unread'; END IF;
  -- An older response cannot erase a newer observation.
  token:=public.crisp_claim_presence(w);
  PERFORM public.crisp_finish_presence(w,token,observed-interval '10 seconds','[]',true,0,0,false);
  IF NOT (SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='new') THEN RAISE EXCEPTION 'Old snapshot erased arrival'; END IF;
  UPDATE public.crisp_workspaces SET visitor_synced_at=NULL WHERE crisp_website_id=w;
  token:=public.crisp_claim_presence(w);
  IF public.crisp_claim_presence(w) IS NOT NULL THEN RAISE EXCEPTION 'Overlapping presence lease'; END IF;
  PERFORM public.crisp_finish_presence(w,token,observed+interval '1 second','[]',false,0,0,true);
  IF NOT (SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='new') THEN RAISE EXCEPTION 'Limited snapshot erased arrival'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:removed','data',jsonb_build_object('session_id','new')));
  IF (SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='new') THEN RAISE EXCEPTION 'Removal left visitor online'; END IF;
  -- The departure must drop the stored live counter in the same transaction,
  -- without waiting for the REST reconciler ('old' was already swept offline).
  IF (SELECT live_visitor_count FROM public.crisp_workspaces WHERE crisp_website_id=w)<>0 THEN
    RAISE EXCEPTION 'Departure did not drop live counter without reconcile'; END IF;
  UPDATE public.crisp_workspaces SET crisp_request_limit=3,crisp_interactive_reserve=1 WHERE crisp_website_id=w;
  IF NOT public.crisp_reserve_request(w) OR NOT public.crisp_reserve_request(w) OR public.crisp_reserve_request(w) THEN RAISE EXCEPTION 'Background budget failed'; END IF;
  IF NOT public.crisp_reserve_request(w,true) OR public.crisp_reserve_request(w,true) THEN RAISE EXCEPTION 'Interactive reserve failed'; END IF;
  INSERT INTO public.crisp_conversations(crisp_website_id,crisp_session_id) VALUES(w,'history-only');
  PERFORM public.crisp_import_messages(jsonb_build_array(jsonb_build_object('crisp_website_id',w,'crisp_session_id','history-only',
    'crisp_message_id','historical-1','direction','incoming','content','Old history','message_type','text','sent_at',now()-interval '1 day')));
  IF EXISTS(SELECT 1 FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='history-only') THEN RAISE EXCEPTION 'History created phantom presence'; END IF;
  IF (SELECT last_message FROM public.crisp_conversations WHERE crisp_website_id=w AND crisp_session_id='history-only') IS DISTINCT FROM 'Old history' THEN RAISE EXCEPTION 'First history message failed to establish summary'; END IF;
  PERFORM public.crisp_record_outgoing(w,'no-fingerprint','Accepted','{}');
  IF EXISTS(SELECT 1 FROM public.crisp_messages WHERE crisp_website_id=w AND crisp_session_id='no-fingerprint') THEN RAISE EXCEPTION 'Synthetic external fingerprint created'; END IF;
  PERFORM public.crisp_mark_read_local((SELECT id FROM public.crisp_conversations WHERE crisp_website_id=w AND crisp_session_id='new'),now());
  IF (SELECT unread_count FROM public.crisp_conversations WHERE crisp_website_id=w AND crisp_session_id='new')<>0 THEN RAISE EXCEPTION 'Read watermark failed'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:set_state',
    'timestamp',(extract(epoch FROM now()-interval '100 milliseconds')*1000)::bigint,
    'data',jsonb_build_object('session_id','new','state','resolved')));
  IF (SELECT status FROM public.crisp_conversations WHERE crisp_website_id=w AND crisp_session_id='new')<>'resolved' THEN RAISE EXCEPTION 'Local read swallowed state event'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:set_state',
    'timestamp',(extract(epoch FROM now()-interval '1 second')*1000)::bigint,
    'data',jsonb_build_object('session_id','new','state','unresolved')));
  IF (SELECT status FROM public.crisp_conversations WHERE crisp_website_id=w AND crisp_session_id='new')<>'resolved' THEN RAISE EXCEPTION 'Old state event rewrote status'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:set_nickname',
    'data',jsonb_build_object('session_id','operator-edit-only','nickname','Edited by operator')));
  IF EXISTS(SELECT 1 FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='operator-edit-only') THEN RAISE EXCEPTION 'Operator metadata edit created phantom visitor'; END IF;
  -- Crisp sends availability either as "online" or as {"type":"online"}. The
  -- nested shape used to fall through to 'availability IS NOT NULL' and mark an
  -- ARRIVING visitor offline; both shapes must now register presence.
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:update_availability',
    'data',jsonb_build_object('session_id','nested-avail','availability',jsonb_build_object('type','online'))));
  IF NOT coalesce((SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='nested-avail'),false) THEN
    RAISE EXCEPTION 'Nested availability payload did not register presence'; END IF;
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:update_availability',
    'data',jsonb_build_object('session_id','nested-avail','availability',jsonb_build_object('type','offline'))));
  IF (SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='nested-avail') THEN
    RAISE EXCEPTION 'Nested availability offline did not clear presence'; END IF;
  -- The bare string shape must keep working.
  PERFORM public.crisp_apply_event(jsonb_build_object('website_id',w,'event','session:update_availability',
    'data',jsonb_build_object('session_id','flat-avail','availability','online')));
  IF NOT coalesce((SELECT is_online FROM public.crisp_visitors WHERE crisp_website_id=w AND crisp_session_id='flat-avail'),false) THEN
    RAISE EXCEPTION 'Flat availability payload stopped registering presence'; END IF;
  RAISE NOTICE 'Crisp pipeline regression checks passed';
END $$;
ROLLBACK;
