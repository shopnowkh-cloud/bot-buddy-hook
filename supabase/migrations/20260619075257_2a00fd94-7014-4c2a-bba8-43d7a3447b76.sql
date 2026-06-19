
CREATE TABLE public.tg_groups (
  chat_id bigint PRIMARY KEY,
  title text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_member boolean NOT NULL DEFAULT true
);
GRANT ALL ON public.tg_groups TO service_role;
ALTER TABLE public.tg_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.scheduled_messages (
  id bigserial PRIMARY KEY,
  keyword text NOT NULL,
  group_chat_id bigint NOT NULL,
  group_title text,
  scheduled_at timestamptz,
  daily_time text,
  repeat_daily boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_messages_enabled_idx ON public.scheduled_messages (enabled);
GRANT ALL ON public.scheduled_messages TO service_role;
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;
