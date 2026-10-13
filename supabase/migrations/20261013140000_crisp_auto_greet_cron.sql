-- Schedule the server-side Crisp auto-greeting sweeper so greetings fire even
-- when no operator browser is open.
--
-- The sweeper edge function (crisp-auto-greet) is invoked every 5 seconds via
-- pg_cron + pg_net. The target URL and the service-role key are read at run time
-- from database settings so no secrets are committed here. Configure them once
-- (replace the placeholders) after enabling pg_cron and pg_net:
--
--   ALTER DATABASE postgres
--     SET app.crisp_auto_greet_url = 'https://<project-ref>.supabase.co/functions/v1/crisp-auto-greet';
--   ALTER DATABASE postgres
--     SET app.crisp_auto_greet_key = '<service_role_key>';
--
-- Until both settings are set, the scheduled job is a no-op (it POSTs nothing).

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
          url := current_setting('app.crisp_auto_greet_url', true),
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || current_setting('app.crisp_auto_greet_key', true),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb
        )
        WHERE coalesce(current_setting('app.crisp_auto_greet_url', true), '') <> ''
          AND coalesce(current_setting('app.crisp_auto_greet_key', true), '') <> '';
      $cron$
    );
  ELSE
    RAISE NOTICE 'Skipping crisp-auto-greet cron: pg_cron and/or pg_net unavailable. Enable them in Database > Extensions, then re-run this migration.';
  END IF;
END
$do$;
