-- Schedule the server-side Crisp auto-greeting sweeper so greetings fire even
-- when no operator browser is open.
--
-- The sweeper edge function (crisp-auto-greet) is invoked every 5 seconds via
-- pg_cron + pg_net. The target URL and the service-role key are read at run time
-- from Supabase Vault so no secrets are committed here, and no database-level
-- parameters are required (ALTER DATABASE is not permitted on Supabase SQL).
--
-- Configure the two Vault secrets once (replace the key placeholder), e.g. in
-- the SQL Editor:
--
--   delete from vault.secrets where name in ('crisp_auto_greet_url','crisp_auto_greet_key');
--   select vault.create_secret(
--     'https://<project-ref>.supabase.co/functions/v1/crisp-auto-greet', 'crisp_auto_greet_url');
--   select vault.create_secret('<service_role_key>', 'crisp_auto_greet_key');
--
-- Until both secrets exist, the scheduled job is a no-op (it POSTs nothing).

DO $do$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_net could not be enabled automatically: %', SQLERRM;
  END;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron could not be enabled automatically: %', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    -- Replace any previous definition of this job.
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'crisp-auto-greet';

    PERFORM cron.schedule(
      'crisp-auto-greet',
      '5 seconds',
      $cron$
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets
                  WHERE name = 'crisp_auto_greet_url'),
          headers := jsonb_build_object(
            'Authorization',
            'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
                          WHERE name = 'crisp_auto_greet_key'),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb
        )
        WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'crisp_auto_greet_url')
          AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'crisp_auto_greet_key');
      $cron$
    );
  ELSE
    RAISE NOTICE 'Skipping crisp-auto-greet cron: pg_cron and/or pg_net unavailable. Enable them in Database > Extensions, then re-run this migration.';
  END IF;
END
$do$;
