-- Keep the Quo SMS history the AI reads.
--
-- Until now the worker fetched a lead's complete Quo conversation, classified
-- it and kept only the verdict. From now on every message it reads is saved
-- here as well, so conversations can be reviewed later and used to improve
-- the AI's rules with real examples.
--
-- Private schema: not exposed through the API, so no signed-in user can read
-- it from the app. Only the backend (service role) writes it, through
-- store_quo_messages, and only the backend or an admin with database access
-- reads it. One row per Quo message; re-reading a conversation updates the
-- row (delivery status can change) and adds the lead to lead_ids, because a
-- number can belong to more than one lead.

CREATE TABLE IF NOT EXISTS private.quo_messages (
  id text PRIMARY KEY,                 -- Quo message id
  phone_number_id text NOT NULL,       -- our Quo inbox (PN...)
  conversation_id text,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  from_number text,
  to_numbers text[] NOT NULL DEFAULT '{}',
  body text NOT NULL DEFAULT '',
  status text,
  has_media boolean NOT NULL DEFAULT false,
  message_created_at timestamptz NOT NULL,
  message_updated_at timestamptz,
  lead_ids uuid[] NOT NULL DEFAULT '{}',
  first_saved_at timestamptz NOT NULL DEFAULT now(),
  last_saved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quo_messages_conversation_idx
  ON private.quo_messages (conversation_id, message_created_at);
CREATE INDEX IF NOT EXISTS quo_messages_lead_ids_idx
  ON private.quo_messages USING gin (lead_ids);

ALTER TABLE private.quo_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.quo_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE private.quo_messages TO service_role;

-- Save the messages of one lead's conversation. Returns how many rows were
-- written. Malformed entries are skipped rather than failing the batch.
CREATE OR REPLACE FUNCTION public.store_quo_messages(p_lead_id uuid, p_messages jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  saved integer;
BEGIN
  IF p_lead_id IS NULL OR jsonb_typeof(p_messages) <> 'array'
     OR jsonb_array_length(p_messages) > 5000 THEN
    RAISE EXCEPTION 'Invalid message batch';
  END IF;

  INSERT INTO private.quo_messages AS m (
    id, phone_number_id, conversation_id, direction, from_number, to_numbers,
    body, status, has_media, message_created_at, message_updated_at, lead_ids
  )
  SELECT DISTINCT ON (x->>'id')
         x->>'id', x->>'phoneNumberId', x->>'conversationId', x->>'direction',
         x->>'from',
         CASE WHEN jsonb_typeof(x->'to') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(x->'to')) ELSE '{}' END,
         coalesce(x->>'text', ''), x->>'status',
         CASE WHEN jsonb_typeof(x->'media') = 'array'
              THEN jsonb_array_length(x->'media') > 0 ELSE false END,
         (x->>'createdAt')::timestamptz,
         nullif(x->>'updatedAt', '')::timestamptz,
         ARRAY[p_lead_id]
    FROM jsonb_array_elements(p_messages) AS x
   WHERE coalesce(x->>'id', '') <> ''
     AND coalesce(x->>'phoneNumberId', '') <> ''
     AND x->>'direction' IN ('incoming', 'outgoing')
     AND coalesce(x->>'createdAt', '') <> ''
  ORDER BY x->>'id', x->>'updatedAt' DESC NULLS LAST
  ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    body = EXCLUDED.body,
    has_media = EXCLUDED.has_media,
    message_updated_at = EXCLUDED.message_updated_at,
    lead_ids = CASE WHEN p_lead_id = ANY (m.lead_ids) THEN m.lead_ids
                    ELSE m.lead_ids || p_lead_id END,
    last_saved_at = now();
  GET DIAGNOSTICS saved = ROW_COUNT;
  RETURN saved;
END
$$;

REVOKE ALL ON FUNCTION public.store_quo_messages(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_quo_messages(uuid, jsonb) TO service_role;
