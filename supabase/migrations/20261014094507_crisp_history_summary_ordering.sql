-- A metadata-only conversation can have a default "now" timestamp but no
-- message yet. Its first historical message must establish the real watermark.
DO $$ DECLARE definition text; previous text; BEGIN
  definition:=pg_get_functiondef('public.crisp_apply_event(jsonb)'::regprocedure);
  previous:=definition;
  definition:=replace(definition,
    'last_message=CASE WHEN source_time>=coalesce(last_message_at,''-infinity'') THEN msg_content ELSE last_message END,',
    'last_message=CASE WHEN last_message IS NULL OR source_time>=coalesce(last_message_at,''-infinity'') THEN msg_content ELSE last_message END,');
  definition:=replace(definition,
    'last_message_at=greatest(last_message_at,source_time),',
    'last_message_at=CASE WHEN last_message IS NULL THEN source_time ELSE greatest(last_message_at,source_time) END,');
  IF definition=previous THEN RAISE EXCEPTION 'Message ingestion definition did not match expected version'; END IF;
  EXECUTE definition;
END $$;
