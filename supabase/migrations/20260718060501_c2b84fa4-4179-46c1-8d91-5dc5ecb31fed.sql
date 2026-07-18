DO $$
BEGIN
  PERFORM cron.unschedule('telegram-sweep-deletions');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('telegram-sweep-schedules');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'telegram-sweep-deletions',
  '10 seconds',
  $job$
    SELECT net.http_post(
      url := 'https://project--b2c164c8-5957-4177-a231-1b8599b547e9-dev.lovable.app/api/public/telegram/sweep-deletions',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 8000
    );
  $job$
);

SELECT cron.schedule(
  'telegram-sweep-schedules',
  '* * * * *',
  $job$
    SELECT net.http_post(
      url := 'https://project--b2c164c8-5957-4177-a231-1b8599b547e9-dev.lovable.app/api/public/telegram/sweep-schedules',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 8000
    );
  $job$
);