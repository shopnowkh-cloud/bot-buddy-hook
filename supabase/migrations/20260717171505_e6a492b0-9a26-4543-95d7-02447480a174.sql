CREATE TABLE public.telegram_updates (
  id bigserial PRIMARY KEY,
  update_id bigint UNIQUE,
  update_type text NOT NULL,
  chat_id bigint,
  chat_title text,
  chat_type text,
  user_id bigint,
  username text,
  text_preview text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_telegram_updates_created_at ON public.telegram_updates (created_at DESC);
CREATE INDEX idx_telegram_updates_chat_id ON public.telegram_updates (chat_id);

GRANT ALL ON public.telegram_updates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.telegram_updates_id_seq TO service_role;

ALTER TABLE public.telegram_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role manages telegram_updates"
  ON public.telegram_updates FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Keep last 30 days only to bound growth.
CREATE OR REPLACE FUNCTION public.prune_telegram_updates()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.telegram_updates WHERE created_at < now() - interval '30 days';
$$;