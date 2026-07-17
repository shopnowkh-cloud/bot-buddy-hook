-- =====================================================================
-- Manual cron setup for sweep endpoints
-- =====================================================================
-- The sweep endpoints (/api/public/telegram/sweep-deletions and
-- /api/public/telegram/sweep-schedules) now require an x-sync-secret
-- header matching the BOT_SYNC_SECRET env var when it is set.
--
-- Run these commands ONCE from the Lovable Cloud SQL runner, replacing
-- <BOT_SYNC_SECRET> with the actual value of that env var (it lives only
-- in Cloud secrets — never commit it to git).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Drop existing schedules (safe if they don't exist)
DO $$ BEGIN PERFORM cron.unschedule('sweep-deletions'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('sweep-schedules'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'sweep-deletions',
  '* * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://bot-buddy-hook.lovable.app/api/public/telegram/sweep-deletions',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', '<BOT_SYNC_SECRET>'
      ),
      body := '{}'::jsonb
    );
  $sql$
);

SELECT cron.schedule(
  'sweep-schedules',
  '* * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://bot-buddy-hook.lovable.app/api/public/telegram/sweep-schedules',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', '<BOT_SYNC_SECRET>'
      ),
      body := '{}'::jsonb
    );
  $sql$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job;
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
