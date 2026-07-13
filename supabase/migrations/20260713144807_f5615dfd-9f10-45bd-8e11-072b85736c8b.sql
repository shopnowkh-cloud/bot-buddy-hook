
CREATE TABLE IF NOT EXISTS public.admin_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  admin_ids bigint[] NOT NULL DEFAULT '{}',
  access_tokens text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.admin_settings TO service_role;
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (server) reads/writes; miniapp API uses service key.

INSERT INTO public.admin_settings (id, admin_ids, access_tokens)
VALUES (1, ARRAY[5002402843]::bigint[], '{}'::text[])
ON CONFLICT (id) DO NOTHING;
