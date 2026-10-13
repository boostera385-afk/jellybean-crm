-- Make Crisp webhooks the primary visitor-sync trigger while preserving
-- delayed auto-greetings and recovery from a missed webhook.
--
-- The frequent job below only reads indexed database rows. It calls the Edge
-- Function when at least one online visitor has a greeting whose delay has
-- expired. A slower backstop sync recovers if Crisp fails to deliver a webhook.

CREATE INDEX IF NOT EXISTS idx_crisp_visitors_auto_greet_due
    ON public.crisp_visitors (auto_greet_due_at, crisp_website_id)
    WHERE is_online = TRUE
      AND auto_greeted_at IS NULL
      AND auto_greet_due_at IS NOT NULL;

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
    -- Remove both the old unconditional job and any previous version of these
    -- optimized jobs so this migration can be safely re-run.
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN (
      'crisp-auto-greet',
      'crisp-auto-greet-due',
      'crisp-auto-greet-backstop'
    );

    -- This job makes no HTTP request unless a delayed greeting is ready.
    PERFORM cron.schedule(
      'crisp-auto-greet-due',
      '10 seconds',
      $cron$
        SELECT net.http_post(
          url := (
            SELECT decrypted_secret
            FROM vault.decrypted_secrets
            WHERE name = 'crisp_auto_greet_url'
            LIMIT 1
          ),
          headers := jsonb_build_object(
            'Authorization',
            'Bearer ' || (
              SELECT decrypted_secret
              FROM vault.decrypted_secrets
              WHERE name = 'crisp_auto_greet_key'
              LIMIT 1
            ),
            'Content-Type', 'application/json'
          ),
          body := jsonb_build_object(
            'websiteId', due.crisp_website_id,
            'immediate', TRUE
          )
        )
        FROM (
          SELECT DISTINCT visitor.crisp_website_id
          FROM public.crisp_visitors AS visitor
          JOIN public.crisp_workspaces AS workspace
            ON workspace.crisp_website_id = visitor.crisp_website_id
          WHERE visitor.is_online = TRUE
            AND visitor.auto_greeted_at IS NULL
            AND visitor.auto_greet_due_at IS NOT NULL
            AND visitor.auto_greet_due_at <= NOW()
            AND workspace.enabled = TRUE
            AND workspace.auto_greet_enabled = TRUE
            AND NULLIF(BTRIM(workspace.auto_greet_message), '') IS NOT NULL
        ) AS due
        WHERE EXISTS (
          SELECT 1
          FROM vault.decrypted_secrets
          WHERE name = 'crisp_auto_greet_url'
        )
          AND EXISTS (
            SELECT 1
            FROM vault.decrypted_secrets
            WHERE name = 'crisp_auto_greet_key'
          );
      $cron$
    );

    -- Webhooks normally keep visitor state current. This infrequent fallback
    -- recovers after a webhook outage or a transient Edge Function failure.
    PERFORM cron.schedule(
      'crisp-auto-greet-backstop',
      '5 minutes',
      $cron$
        SELECT net.http_post(
          url := (
            SELECT decrypted_secret
            FROM vault.decrypted_secrets
            WHERE name = 'crisp_auto_greet_url'
            LIMIT 1
          ),
          headers := jsonb_build_object(
            'Authorization',
            'Bearer ' || (
              SELECT decrypted_secret
              FROM vault.decrypted_secrets
              WHERE name = 'crisp_auto_greet_key'
              LIMIT 1
            ),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb
        )
        WHERE EXISTS (
          SELECT 1
          FROM vault.decrypted_secrets
          WHERE name = 'crisp_auto_greet_url'
        )
          AND EXISTS (
            SELECT 1
            FROM vault.decrypted_secrets
            WHERE name = 'crisp_auto_greet_key'
          )
          AND EXISTS (
            SELECT 1
            FROM public.crisp_workspaces
            WHERE enabled = TRUE
              AND auto_greet_enabled = TRUE
              AND NULLIF(BTRIM(auto_greet_message), '') IS NOT NULL
          );
      $cron$
    );
  ELSE
    RAISE NOTICE 'Skipping optimized Crisp cron jobs: pg_cron and/or pg_net unavailable. Enable them in Database > Extensions, then re-run this migration.';
  END IF;
END
$do$;
