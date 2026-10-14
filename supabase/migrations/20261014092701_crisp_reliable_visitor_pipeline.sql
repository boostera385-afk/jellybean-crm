-- Additive cutover: preserve saved visitors and legacy greeting markers.
-- No history backfill: only newly observed sessions are eligible for new jobs.
ALTER TABLE public.crisp_workspaces
  ADD COLUMN pipeline_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN greeting_worker_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN visitor_sync_lease uuid,
  ADD COLUMN visitor_sync_lease_until timestamptz,
  ADD COLUMN visitor_sync_succeeded_at timestamptz,
  ADD COLUMN visitor_sync_error text,
  ADD COLUMN crisp_request_limit integer NOT NULL DEFAULT 10000 CHECK (crisp_request_limit > 0),
  ADD COLUMN crisp_interactive_reserve integer NOT NULL DEFAULT 1000 CHECK (crisp_interactive_reserve >= 0),
  ADD COLUMN crisp_cooldown_until timestamptz;
ALTER TABLE public.crisp_visitors ADD COLUMN presence_observed_at timestamptz;
ALTER TABLE public.crisp_conversations ADD COLUMN last_read_at timestamptz;
ALTER TABLE public.crisp_webhook_events
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN processed_at timestamptz;
CREATE INDEX crisp_events_pending_idx ON public.crisp_webhook_events(next_attempt_at, received_at)
  WHERE NOT processed AND attempts < 8;

CREATE TABLE public.crisp_greeting_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crisp_website_id text NOT NULL,
  crisp_session_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','sending','sent','uncertain','failed','cancelled')),
  content text NOT NULL,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  request_started_at timestamptz,
  sent_at timestamptz,
  external_fingerprint text,
  last_error text,
  UNIQUE(crisp_website_id, crisp_session_id)
);
CREATE INDEX crisp_greetings_pending_idx ON public.crisp_greeting_jobs(crisp_website_id, due_at)
  WHERE state IN ('pending','leased','sending');
ALTER TABLE public.crisp_greeting_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crisp_greeting_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.crisp_greeting_jobs TO service_role;

-- Hourly aggregates bound storage and enforce a conservative rolling window.
-- This is NOT a claim about Crisp's own daily reset timezone.
CREATE TABLE public.crisp_api_usage (
  crisp_website_id text NOT NULL,
  bucket_at timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY(crisp_website_id, bucket_at)
);
ALTER TABLE public.crisp_api_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crisp_api_usage FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.crisp_api_usage TO service_role;

REVOKE ALL ON FUNCTION public.claim_crisp_visitor_sync(text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_crisp_visitor_sync(text,timestamptz) TO service_role;

-- Exact comparison against the EXISTING cron secret; no unverified JWT decoding.
-- Only service_role can call this; the secret itself never leaves Vault.
CREATE FUNCTION public.crisp_worker_authorized(p_token text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT length(p_token) > 0 AND EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'crisp_auto_greet_key' AND decrypted_secret = p_token
  );
$$;

CREATE FUNCTION public.crisp_reserve_request(p_website_id text, p_interactive boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE w public.crisp_workspaces; used integer;
BEGIN
  SELECT * INTO w FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND enabled FOR UPDATE;
  IF NOT FOUND OR w.crisp_cooldown_until > now() THEN RETURN false; END IF;
  SELECT coalesce(sum(requests),0) INTO used FROM public.crisp_api_usage
    WHERE crisp_website_id=p_website_id AND bucket_at >= date_trunc('hour',now()-interval '24 hours');
  IF used >= w.crisp_request_limit - (CASE WHEN p_interactive THEN 0 ELSE w.crisp_interactive_reserve END)
    THEN RETURN false; END IF;
  INSERT INTO public.crisp_api_usage VALUES(p_website_id,date_trunc('hour',now()),1)
    ON CONFLICT(crisp_website_id,bucket_at) DO UPDATE SET requests=public.crisp_api_usage.requests+1;
  DELETE FROM public.crisp_api_usage WHERE crisp_website_id=p_website_id AND bucket_at < now()-interval '48 hours';
  RETURN true;
END; $$;

CREATE FUNCTION public.crisp_set_cooldown(p_website_id text,p_seconds integer) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.crisp_workspaces SET crisp_cooldown_until=greatest(crisp_cooldown_until,now()+make_interval(secs=>greatest(1,least(3600,p_seconds))))
    WHERE crisp_website_id=p_website_id;
$$;

CREATE FUNCTION public.crisp_claim_presence(p_website_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE token uuid := gen_random_uuid();
BEGIN
  UPDATE public.crisp_workspaces SET visitor_sync_lease=token,
    visitor_sync_lease_until=now()+interval '2 minutes',visitor_synced_at=now()
  WHERE crisp_website_id=p_website_id AND enabled
    AND (visitor_sync_lease_until IS NULL OR visitor_sync_lease_until <= now())
    AND (visitor_synced_at IS NULL OR visitor_synced_at <= now()-interval '20 seconds');
  IF FOUND THEN RETURN token; END IF;
  RETURN NULL;
END; $$;

CREATE FUNCTION public.crisp_enqueue_greeting() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE w public.crisp_workspaces; delay integer;
BEGIN
  IF NOT NEW.is_online OR NEW.auto_greeted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO w FROM public.crisp_workspaces WHERE crisp_website_id=NEW.crisp_website_id;
  IF NOT w.enabled OR NOT w.greeting_worker_enabled OR NOT w.auto_greet_enabled
    OR NEW.first_seen_at < w.pipeline_started_at OR nullif(trim(w.auto_greet_message),'') IS NULL THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM public.crisp_conversations WHERE crisp_website_id=NEW.crisp_website_id
    AND crisp_session_id=NEW.crisp_session_id AND nullif(last_message,'') IS NOT NULL) THEN RETURN NEW; END IF;
  delay := greatest(0,least(3600,w.auto_greet_delay_seconds));
  INSERT INTO public.crisp_greeting_jobs(crisp_website_id,crisp_session_id,content,due_at,expires_at)
  VALUES(NEW.crisp_website_id,NEW.crisp_session_id,
    regexp_replace(regexp_replace(w.auto_greet_message,'\{\{\s*name\s*\}\}',coalesce(NEW.nickname,'there'),'gi'),
      '\{\{\s*city\s*\}\}',coalesce(NEW.city,''),'gi'),
    NEW.first_seen_at+make_interval(secs=>delay),NEW.first_seen_at+make_interval(secs=>delay)+interval '2 minutes')
  ON CONFLICT(crisp_website_id,crisp_session_id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER crisp_enqueue_greeting AFTER INSERT OR UPDATE ON public.crisp_visitors
  FOR EACH ROW EXECUTE FUNCTION public.crisp_enqueue_greeting();

CREATE FUNCTION public.crisp_finish_presence(p_website_id text,p_token uuid,p_started_at timestamptz,
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
    live_visitor_count=CASE WHEN p_error IS NULL THEN coalesce(p_count,jsonb_array_length(p_rows)) ELSE live_visitor_count END,
    active_visitor_count=CASE WHEN p_error IS NULL THEN coalesce(p_active,active_visitor_count) ELSE active_visitor_count END,
    visitors_limited=CASE WHEN p_error IS NULL THEN p_limited ELSE visitors_limited END
    WHERE crisp_website_id=p_website_id;
  RETURN true;
END; $$;

-- Receipt transaction: do not acknowledge an event until its durable insert commits.
CREATE FUNCTION public.crisp_accept_event(p_body jsonb,p_fingerprint text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE event_id uuid; website text := coalesce(p_body->>'website_id',p_body#>>'{data,website_id}');
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=website AND enabled) THEN
    RAISE EXCEPTION 'Workspace unavailable'; END IF;
  INSERT INTO public.crisp_webhook_events(crisp_website_id,event_fingerprint,event_type,payload,processed)
    VALUES(website,p_fingerprint,lower(p_body->>'event'),p_body,false)
    ON CONFLICT(event_fingerprint) DO UPDATE SET event_fingerprint=EXCLUDED.event_fingerprint
    RETURNING id INTO event_id;
  RETURN event_id;
END; $$;

-- All message/unread/presence mutations for an event commit together.
CREATE FUNCTION public.crisp_apply_event(p_body jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  d jsonb := coalesce(p_body->'data',p_body); e text := lower(p_body->>'event');
  website text := coalesce(p_body->>'website_id',p_body#>>'{data,website_id}'); session text;
  observed timestamptz := now(); source_time timestamptz := now(); stamp text;
  online boolean; activity boolean; is_message boolean; operator_message boolean; masked boolean;
  message_id text; msg_content text; inserted_id uuid; conv public.crisp_conversations;
  page jsonb; geo jsonb; receipts text[]; next_state text; matched integer; reply_cutoff timestamptz;
BEGIN
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=website AND enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.crisp_workspaces SET last_seen_at=now() WHERE crisp_website_id=website;
  session := coalesce(d->>'session_id',p_body->>'session_id');
  IF session IS NULL THEN RETURN; END IF;
  stamp := coalesce(d->>'timestamp',p_body->>'timestamp');
  IF stamp ~ '^[0-9]{13}$' THEN source_time := least(now(),to_timestamp(stamp::numeric/1000)); END IF;
  is_message := e IN ('message:send','message:received');
  operator_message := coalesce(d->>'from','user')='operator';
  IF e LIKE 'message:acknowledge:%' THEN
    IF e NOT LIKE '%:read%' AND e NOT LIKE '%:delivered%' THEN RETURN; END IF;
    SELECT array_agg(value) INTO receipts FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(d->'fingerprints')='array' THEN d->'fingerprints'
      WHEN d->>'fingerprint' IS NOT NULL THEN jsonb_build_array(d->>'fingerprint') ELSE '[]'::jsonb END);
    next_state := CASE WHEN e LIKE '%:read%' THEN 'seen' ELSE 'delivered' END;
    UPDATE public.crisp_messages SET delivery_state=next_state WHERE crisp_website_id=website AND crisp_session_id=session
      AND direction='outgoing' AND crisp_message_id=ANY(receipts)
      AND delivery_state IN ('sent',CASE WHEN next_state='seen' THEN 'delivered' ELSE 'sent' END);
    SELECT count(*) INTO matched FROM public.crisp_messages WHERE crisp_website_id=website AND crisp_session_id=session AND crisp_message_id=ANY(receipts);
    IF coalesce(array_length(receipts,1),0)>matched THEN RAISE EXCEPTION 'Unmatched delivery receipt'; END IF;
    RETURN;
  END IF;
  activity := (e='message:send' AND NOT operator_message) OR e LIKE 'session:sync:%'
    OR e LIKE 'session:set_%' OR e='session:request:initiated' OR d->>'availability'='online';
  online := CASE WHEN e='session:removed' THEN false WHEN d->>'availability' IS NOT NULL THEN d->>'availability'='online'
    WHEN activity THEN true ELSE NULL END;
  page := coalesce(d->'last_page',d->'page',d->'pages'->-1,'{}'); geo := coalesce(d->'geolocation','{}');
  IF online IS NOT NULL THEN
    INSERT INTO public.crisp_visitors(crisp_website_id,crisp_session_id,nickname,email,avatar,user_agent,
      initiated,is_online,active,last_seen_at,last_online_at,presence_observed_at,last_page_url,last_page_title,country,region,city)
    VALUES(website,session,coalesce(d#>>'{user,nickname}',d->>'nickname'),coalesce(d#>>'{user,email}',d->>'email'),
      coalesce(d#>>'{user,avatar}',d->>'avatar'),d->>'useragent',is_message,online,online,
      source_time,CASE WHEN online THEN source_time END,source_time,coalesce(page->>'page_url',page->>'url'),
      coalesce(page->>'page_title',page->>'title'),geo->>'country',geo->>'region',geo->>'city')
    ON CONFLICT(crisp_website_id,crisp_session_id) DO UPDATE SET
      nickname=coalesce(EXCLUDED.nickname,public.crisp_visitors.nickname),email=coalesce(EXCLUDED.email,public.crisp_visitors.email),
      avatar=coalesce(EXCLUDED.avatar,public.crisp_visitors.avatar),user_agent=coalesce(EXCLUDED.user_agent,public.crisp_visitors.user_agent),
      initiated=EXCLUDED.initiated OR public.crisp_visitors.initiated,is_online=EXCLUDED.is_online,active=EXCLUDED.active,
      last_seen_at=greatest(public.crisp_visitors.last_seen_at,EXCLUDED.last_seen_at),
      last_online_at=coalesce(EXCLUDED.last_online_at,public.crisp_visitors.last_online_at),presence_observed_at=source_time,
      last_page_url=coalesce(EXCLUDED.last_page_url,public.crisp_visitors.last_page_url),last_page_title=coalesce(EXCLUDED.last_page_title,public.crisp_visitors.last_page_title),
      country=coalesce(EXCLUDED.country,public.crisp_visitors.country),region=coalesce(EXCLUDED.region,public.crisp_visitors.region),city=coalesce(EXCLUDED.city,public.crisp_visitors.city),updated_at=now()
    WHERE coalesce(public.crisp_visitors.presence_observed_at,'-infinity')<=source_time;
    IF online THEN
      INSERT INTO public.crisp_visitor_daily_visits(crisp_website_id,crisp_session_id,visit_date,last_seen_at)
      VALUES(website,session,(source_time AT TIME ZONE 'Asia/Karachi')::date,source_time)
      ON CONFLICT(crisp_website_id,crisp_session_id,visit_date) DO UPDATE SET last_seen_at=greatest(public.crisp_visitor_daily_visits.last_seen_at,EXCLUDED.last_seen_at),updated_at=now();
    END IF;
  END IF;
  -- Notification/control events never rewrite conversation message summaries.
  IF NOT is_message AND e NOT IN ('session:set_state','session:set_email','session:set_nickname','session:set_phone') THEN RETURN; END IF;
  INSERT INTO public.crisp_conversations(crisp_website_id,crisp_session_id,last_message_at)
    VALUES(website,session,NULL) ON CONFLICT(crisp_website_id,crisp_session_id) DO NOTHING;
  SELECT * INTO conv FROM public.crisp_conversations WHERE crisp_website_id=website AND crisp_session_id=session FOR UPDATE;
  UPDATE public.crisp_conversations SET customer_name=coalesce(d#>>'{user,nickname}',d->>'nickname',customer_name),
    customer_email=coalesce(d#>>'{user,email}',d->>'email',customer_email),customer_phone=coalesce(d#>>'{user,phone}',d->>'phone',customer_phone),
    customer_avatar=coalesce(d#>>'{user,avatar}',d->>'avatar',customer_avatar),
    status=CASE WHEN e='session:set_state' AND source_time>=coalesce(conv.updated_at,'-infinity') THEN coalesce(d->>'state',status) ELSE status END,
    updated_at=now() WHERE id=conv.id;
  IF NOT is_message THEN RETURN; END IF;
  msg_content := CASE WHEN jsonb_typeof(d->'content')='string' THEN d->>'content'
    ELSE coalesce(d#>>'{content,text}',d#>>'{content,name}',CASE WHEN d->>'type'='audio' THEN '[Audio]' WHEN d->>'type' IN ('file','attachment') THEN '[File]' ELSE '[Attachment]' END) END;
  message_id := coalesce(d->>'fingerprint',session||'_'||source_time::text);
  masked := length(regexp_replace(msg_content,'[^[:alnum:]]','','g'))>=3 AND regexp_replace(msg_content,'[^[:alnum:]]','','g') ~* '^x+$';
  INSERT INTO public.crisp_messages(conversation_id,crisp_website_id,crisp_session_id,crisp_message_id,sender_type,direction,content,message_type,sent_at,raw_payload)
    VALUES(conv.id,website,session,message_id,CASE WHEN operator_message THEN 'operator' ELSE 'customer' END,
      CASE WHEN operator_message THEN 'outgoing' ELSE 'incoming' END,msg_content,coalesce(d->>'type','text'),source_time,d)
    ON CONFLICT(crisp_website_id,crisp_message_id) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN
    SELECT greatest(conv.last_read_at,max(sent_at)) INTO reply_cutoff FROM public.crisp_messages
      WHERE crisp_website_id=website AND crisp_session_id=session AND
        (direction='outgoing' OR (length(regexp_replace(content,'[^[:alnum:]]','','g'))>=3 AND regexp_replace(content,'[^[:alnum:]]','','g') ~* '^x+$'));
    UPDATE public.crisp_conversations SET
      last_message=CASE WHEN source_time>=coalesce(last_message_at,'-infinity') THEN msg_content ELSE last_message END,
      last_message_at=greatest(last_message_at,source_time),
      unread_count=(SELECT count(*) FROM public.crisp_messages WHERE crisp_website_id=website AND crisp_session_id=session
        AND direction='incoming' AND sent_at>coalesce(reply_cutoff,'-infinity')),
      last_customer_unread_at=(SELECT max(sent_at) FROM public.crisp_messages WHERE crisp_website_id=website AND crisp_session_id=session
        AND direction='incoming' AND sent_at>coalesce(reply_cutoff,'-infinity')),updated_at=now() WHERE id=conv.id;
  END IF;
  -- Independent outgoing webhook can confirm an ambiguous accepted greeting.
  IF operator_message THEN
    UPDATE public.crisp_greeting_jobs SET state='sent',sent_at=source_time,external_fingerprint=message_id,last_error=NULL
    WHERE crisp_website_id=website AND crisp_session_id=session AND state IN ('sending','uncertain')
      AND msg_content=crisp_greeting_jobs.content AND source_time>=request_started_at-interval '1 second';
  END IF;
END; $$;

CREATE FUNCTION public.crisp_process_events(p_website_id text DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE ev public.crisp_webhook_events; n integer:=0;
BEGIN
  FOR ev IN SELECT * FROM public.crisp_webhook_events WHERE NOT processed AND attempts<8 AND next_attempt_at<=now()
    AND (p_website_id IS NULL OR crisp_website_id=p_website_id)
    ORDER BY received_at LIMIT greatest(1,least(100,p_limit)) FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      PERFORM public.crisp_apply_event(ev.payload);
      UPDATE public.crisp_webhook_events SET processed=true,processed_at=now(),error=NULL,attempts=attempts+1 WHERE id=ev.id;
      n:=n+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.crisp_webhook_events SET attempts=attempts+1,error=left(SQLERRM,200),
        next_attempt_at=now()+make_interval(secs=>least(300,(2^least(ev.attempts+1,8))::integer)) WHERE id=ev.id;
    END;
  END LOOP;
  RETURN n;
END; $$;

CREATE FUNCTION public.crisp_mark_read_local(p_conversation_id uuid,p_observed_at timestamptz) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.crisp_conversations c SET last_read_at=greatest(c.last_read_at,p_observed_at),
    unread_count=(SELECT count(*) FROM public.crisp_messages m WHERE m.conversation_id=c.id AND m.direction='incoming'
      AND m.sent_at>greatest(coalesce(c.last_read_at,'-infinity'),p_observed_at)),
    last_customer_unread_at=(SELECT max(m.sent_at) FROM public.crisp_messages m WHERE m.conversation_id=c.id AND m.direction='incoming'
      AND m.sent_at>greatest(coalesce(c.last_read_at,'-infinity'),p_observed_at)),updated_at=now()
    WHERE c.id=p_conversation_id;
$$;

CREATE FUNCTION public.crisp_claim_greetings(p_website_id text,p_limit integer DEFAULT 2) RETURNS SETOF public.crisp_greeting_jobs
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE slots integer;
BEGIN
  -- Bound external-send concurrency across overlapping Edge invocations too.
  PERFORM pg_advisory_xact_lock(hashtextextended('crisp-greeting-claims',0));
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND enabled AND greeting_worker_enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.crisp_greeting_jobs SET state='uncertain',last_error='Worker stopped after send began'
    WHERE crisp_website_id=p_website_id AND state='sending' AND lease_until<=now();
  UPDATE public.crisp_greeting_jobs SET state='pending',lease_token=NULL,lease_until=NULL
    WHERE crisp_website_id=p_website_id AND state='leased' AND lease_until<=now();
  UPDATE public.crisp_greeting_jobs j SET state='cancelled',last_error='Expired or no longer eligible'
    WHERE j.crisp_website_id=p_website_id AND j.state='pending' AND (j.expires_at<=now() OR j.attempts>=5 OR NOT EXISTS(
      SELECT 1 FROM public.crisp_visitors v JOIN public.crisp_workspaces w USING(crisp_website_id)
      WHERE v.crisp_website_id=j.crisp_website_id AND v.crisp_session_id=j.crisp_session_id AND v.is_online
        AND v.auto_greeted_at IS NULL AND w.auto_greet_enabled AND w.enabled)
      OR EXISTS(SELECT 1 FROM public.crisp_conversations c WHERE c.crisp_website_id=j.crisp_website_id AND c.crisp_session_id=j.crisp_session_id AND nullif(c.last_message,'') IS NOT NULL));
  SELECT least(2-count(*) FILTER(WHERE crisp_website_id=p_website_id),6-count(*))::integer INTO slots
    FROM public.crisp_greeting_jobs WHERE state IN ('leased','sending') AND lease_until>now();
  IF slots<=0 THEN RETURN; END IF;
  RETURN QUERY UPDATE public.crisp_greeting_jobs SET state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '30 seconds',attempts=attempts+1
    WHERE id IN(SELECT id FROM public.crisp_greeting_jobs WHERE crisp_website_id=p_website_id AND state='pending'
      AND due_at<=now() ORDER BY due_at LIMIT greatest(1,least(slots,p_limit)) FOR UPDATE SKIP LOCKED) RETURNING *;
END; $$;

CREATE FUNCTION public.crisp_begin_greeting(p_id uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE j public.crisp_greeting_jobs;
BEGIN
  SELECT * INTO j FROM public.crisp_greeting_jobs WHERE id=p_id;
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=j.crisp_website_id AND enabled AND auto_greet_enabled AND greeting_worker_enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO j FROM public.crisp_greeting_jobs WHERE id=p_id AND state='leased' AND lease_token=p_token AND lease_until>now() AND expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.crisp_conversations WHERE crisp_website_id=j.crisp_website_id AND crisp_session_id=j.crisp_session_id AND nullif(last_message,'') IS NOT NULL) THEN
    UPDATE public.crisp_greeting_jobs SET state='cancelled' WHERE id=p_id; RETURN false; END IF;
  UPDATE public.crisp_visitors SET auto_greeted_at=now() WHERE crisp_website_id=j.crisp_website_id AND crisp_session_id=j.crisp_session_id
    AND is_online AND auto_greeted_at IS NULL;
  IF NOT FOUND THEN UPDATE public.crisp_greeting_jobs SET state='cancelled' WHERE id=p_id; RETURN false; END IF;
  UPDATE public.crisp_greeting_jobs SET state='sending',request_started_at=now() WHERE id=p_id;
  RETURN true;
END; $$;

CREATE FUNCTION public.crisp_complete_greeting(p_id uuid,p_token uuid,p_outcome text,p_response jsonb DEFAULT NULL,p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE j public.crisp_greeting_jobs; message jsonb;
BEGIN
  SELECT * INTO j FROM public.crisp_greeting_jobs WHERE id=p_id;
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=j.crisp_website_id FOR UPDATE;
  SELECT * INTO j FROM public.crisp_greeting_jobs WHERE id=p_id AND lease_token=p_token AND state IN ('leased','sending') FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_outcome NOT IN ('sent','retry','failed','uncertain') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
  IF p_outcome='retry' THEN
    UPDATE public.crisp_visitors SET auto_greeted_at=NULL WHERE crisp_website_id=j.crisp_website_id AND crisp_session_id=j.crisp_session_id;
  END IF;
  UPDATE public.crisp_greeting_jobs SET state=CASE WHEN p_outcome='retry' THEN 'pending' ELSE p_outcome END,
    due_at=CASE WHEN p_outcome='retry' THEN now()+interval '60 seconds' ELSE due_at END,last_error=left(p_error,200),
    sent_at=CASE WHEN p_outcome='sent' THEN now() ELSE sent_at END WHERE id=p_id;
  IF p_outcome='sent' THEN
    message:=coalesce(p_response->'data',p_response);
    UPDATE public.crisp_greeting_jobs SET external_fingerprint=message->>'fingerprint' WHERE id=p_id;
    IF message->>'fingerprint' IS NOT NULL THEN
      PERFORM public.crisp_apply_event(jsonb_build_object('website_id',j.crisp_website_id,'event','message:received',
        'timestamp',coalesce(message->'timestamp',to_jsonb((extract(epoch FROM now())*1000)::bigint)),
        'data',message||jsonb_build_object('session_id',j.crisp_session_id,'from','operator','type','text','content',j.content)));
    END IF;
  END IF;
END; $$;

-- Default privileges can include direct anon grants: revoke all explicitly.
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('crisp_worker_authorized','crisp_reserve_request','crisp_set_cooldown','crisp_claim_presence','crisp_enqueue_greeting',
     'crisp_finish_presence','crisp_accept_event','crisp_apply_event','crisp_process_events','crisp_mark_read_local','crisp_claim_greetings','crisp_begin_greeting','crisp_complete_greeting') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;
