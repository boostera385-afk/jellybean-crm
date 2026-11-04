-- Quo issues a separate signing key for every API-created webhook. Keep keys
-- outside the exposed public schema so the completed-call subscription can be
-- created by the backend without copying credentials into application code.
CREATE TABLE IF NOT EXISTS private.quo_webhook_keys (
  webhook_id text PRIMARY KEY CHECK (webhook_id ~ '^[A-Za-z0-9_-]{3,200}$'),
  signing_key text NOT NULL CHECK (signing_key ~ '^whsec_[A-Za-z0-9_+/=-]{8,}$'),
  event_types text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.quo_webhook_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.quo_webhook_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE private.quo_webhook_keys TO service_role;

CREATE OR REPLACE FUNCTION public.store_quo_webhook_key(
  p_webhook_id text,
  p_signing_key text,
  p_event_types text[] DEFAULT '{}'::text[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_webhook_id IS NULL OR p_webhook_id !~ '^[A-Za-z0-9_-]{3,200}$'
    OR p_signing_key IS NULL OR p_signing_key !~ '^whsec_[A-Za-z0-9_+/=-]{8,}$'
    OR p_event_types IS NULL OR cardinality(p_event_types) > 40
    OR EXISTS (SELECT 1 FROM unnest(p_event_types) AS event_type
               WHERE event_type !~ '^[a-z][a-z0-9_.-]{1,79}$') THEN
    RAISE EXCEPTION 'Invalid Quo webhook key';
  END IF;

  INSERT INTO private.quo_webhook_keys AS keys (webhook_id, signing_key, event_types)
  VALUES (p_webhook_id, p_signing_key, p_event_types)
  ON CONFLICT (webhook_id) DO UPDATE
    SET signing_key = excluded.signing_key,
        event_types = excluded.event_types,
        updated_at = now();
END
$function$;

CREATE OR REPLACE FUNCTION public.get_quo_webhook_keys()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(array_agg(keys.signing_key ORDER BY keys.created_at), '{}'::text[])
  FROM private.quo_webhook_keys AS keys
$function$;

REVOKE ALL ON FUNCTION public.store_quo_webhook_key(text, text, text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_quo_webhook_keys()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_quo_webhook_key(text, text, text[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_quo_webhook_keys()
  TO service_role;
