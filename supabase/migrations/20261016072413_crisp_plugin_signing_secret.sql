-- The signed Plugin Hooks feed (crisp-plugin-webhook) verifies
-- HMAC([timestamp;JSON.stringify(body)]) with the Marketplace hook's signing
-- secret. Edge env secrets cannot be set from this environment, so the secret
-- lives in the project vault under the fixed name below; the endpoint falls
-- back to it when CRISP_PLUGIN_SIGNING_SECRET is unset in Edge secrets.
-- The secret VALUE is inserted by hand (vault.create_secret) and never
-- committed to git; rotation = update the vault row.

CREATE OR REPLACE FUNCTION public.crisp_read_plugin_signing_secret()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'crisp_plugin_signing_secret'
  ORDER BY created_at DESC
  LIMIT 1;
  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.crisp_read_plugin_signing_secret()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crisp_read_plugin_signing_secret()
TO service_role;
