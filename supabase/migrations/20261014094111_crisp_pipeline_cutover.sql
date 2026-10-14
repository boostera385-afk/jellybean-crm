-- Apply only after the new crisp-auto-greet worker is deployed and SQL checks
-- pass. Existing auto_greet_enabled still controls whether a workspace sends.
ALTER TABLE public.crisp_workspaces ALTER COLUMN greeting_worker_enabled SET DEFAULT true;
UPDATE public.crisp_workspaces SET greeting_worker_enabled=true WHERE enabled;
-- Old deployed app versions may still call the overview-owned sync path.
-- Preserve its signature but prevent it from becoming a second greeting sender.
CREATE OR REPLACE FUNCTION public.claim_crisp_visitor_sync(p_website_id text,p_stale_before timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.crisp_workspaces SET visitor_synced_at=now(),updated_at=now()
    WHERE crisp_website_id=p_website_id AND enabled AND NOT greeting_worker_enabled
      AND (visitor_synced_at IS NULL OR visitor_synced_at<p_stale_before);
  RETURN FOUND;
END; $$;
REVOKE ALL ON FUNCTION public.claim_crisp_visitor_sync(text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_crisp_visitor_sync(text,timestamptz) TO service_role;
-- Recover only recent, post-migration arrivals seen during the short cutover.
-- This does not reset markers or enqueue historical visitors.
UPDATE public.crisp_visitors v SET updated_at=now()
FROM public.crisp_workspaces w
WHERE v.crisp_website_id=w.crisp_website_id AND v.first_seen_at>=w.pipeline_started_at
  AND v.first_seen_at>=now()-interval '2 minutes' AND v.is_online AND v.auto_greeted_at IS NULL;

-- History imports share transactional message ordering/unread accounting but
-- must never turn an old message into a live presence observation.
DO $$ DECLARE definition text; BEGIN
  definition:=pg_get_functiondef('public.crisp_apply_event(jsonb)'::regprocedure);
  definition:=replace(definition,'IF online IS NOT NULL THEN',
    'IF online IS NOT NULL AND coalesce(p_body->>''source'','''')<>''history'' THEN');
  EXECUTE definition;
END $$;

CREATE FUNCTION public.crisp_import_messages(p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE row jsonb; n integer:=0; existed boolean;
BEGIN
  IF jsonb_array_length(p_rows)>500 THEN RAISE EXCEPTION 'History batch too large'; END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=row->>'crisp_website_id' FOR UPDATE;
    SELECT EXISTS(SELECT 1 FROM public.crisp_messages WHERE crisp_website_id=row->>'crisp_website_id'
      AND crisp_message_id=row->>'crisp_message_id') INTO existed;
    PERFORM public.crisp_apply_event(jsonb_build_object('website_id',row->>'crisp_website_id','source','history',
      'event',CASE WHEN row->>'direction'='outgoing' THEN 'message:received' ELSE 'message:send' END,
      'timestamp',(extract(epoch FROM (row->>'sent_at')::timestamptz)*1000)::bigint,
      'data',coalesce(row->'raw_payload','{}')||jsonb_build_object('session_id',row->>'crisp_session_id','fingerprint',row->>'crisp_message_id',
        'from',CASE WHEN row->>'direction'='outgoing' THEN 'operator' ELSE 'user' END,
        'content',row->>'content','type',row->>'message_type')));
    IF NOT existed THEN n:=n+1; END IF;
  END LOOP;
  RETURN n;
END; $$;
REVOKE ALL ON FUNCTION public.crisp_import_messages(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_import_messages(jsonb) TO service_role;

CREATE FUNCTION public.crisp_record_outgoing(p_website_id text,p_session_id text,p_content text,p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE message jsonb:=coalesce(p_payload->'data',p_payload); conv_id uuid;
BEGIN
  PERFORM 1 FROM public.crisp_workspaces WHERE crisp_website_id=p_website_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace unavailable'; END IF;
  INSERT INTO public.crisp_conversations(crisp_website_id,crisp_session_id,customer_name,customer_email,customer_avatar,last_message_at)
    SELECT p_website_id,p_session_id,nickname,email,avatar,NULL FROM public.crisp_visitors
    WHERE crisp_website_id=p_website_id AND crisp_session_id=p_session_id
    ON CONFLICT(crisp_website_id,crisp_session_id) DO NOTHING;
  IF message->>'fingerprint' IS NOT NULL THEN
    PERFORM public.crisp_apply_event(jsonb_build_object('website_id',p_website_id,'event','message:received',
      'timestamp',coalesce(message->'timestamp',to_jsonb((extract(epoch FROM now())*1000)::bigint)),
      'data',message||jsonb_build_object('session_id',p_session_id,'from','operator','content',p_content,'type','text')));
  ELSE
    -- An accepted response without an external identity is not a new message ID.
    -- Keep a conversation available, then let the outgoing webhook mirror it.
    INSERT INTO public.crisp_conversations(crisp_website_id,crisp_session_id,last_message,last_message_at)
      VALUES(p_website_id,p_session_id,p_content,now())
      ON CONFLICT(crisp_website_id,crisp_session_id) DO UPDATE SET
        last_message=coalesce(public.crisp_conversations.last_message,EXCLUDED.last_message);
  END IF;
  SELECT id INTO conv_id FROM public.crisp_conversations WHERE crisp_website_id=p_website_id AND crisp_session_id=p_session_id;
  RETURN conv_id;
END; $$;
REVOKE ALL ON FUNCTION public.crisp_record_outgoing(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_record_outgoing(text,text,text,jsonb) TO service_role;
