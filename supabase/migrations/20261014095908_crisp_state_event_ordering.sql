-- Conversation state has its own source watermark. Message imports, local
-- reads and ordinary updated_at writes must not discard a delayed state event.
ALTER TABLE public.crisp_conversations ADD COLUMN state_observed_at timestamptz;

DO $$ DECLARE definition text; BEGIN
  definition:=pg_get_functiondef('public.crisp_apply_event(jsonb)'::regprocedure);
  IF strpos(definition,'source_time>=coalesce(conv.updated_at,''-infinity'')')=0 THEN
    RAISE EXCEPTION 'Unexpected state ingestion definition';
  END IF;
  definition:=replace(definition,
    'source_time>=coalesce(conv.updated_at,''-infinity'')',
    'source_time>=coalesce(conv.state_observed_at,''-infinity'')');
  definition:=replace(definition,
    'coalesce(d->>''state'',status) ELSE status END,',
    'coalesce(d->>''state'',status) ELSE status END,
    state_observed_at=CASE WHEN e=''session:set_state'' AND source_time>=coalesce(conv.state_observed_at,''-infinity'')
      THEN source_time ELSE state_observed_at END,');
  -- Operator edits are not evidence that the visitor is currently online.
  definition:=replace(definition,'OR e LIKE ''session:set_%'' OR e=''session:request:initiated''',
    'OR e=''session:request:initiated''');
  EXECUTE definition;
END $$;
