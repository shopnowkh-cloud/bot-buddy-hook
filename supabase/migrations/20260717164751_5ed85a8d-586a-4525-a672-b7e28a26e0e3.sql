
-- Usage logs table
CREATE TABLE public.usage_logs (
  id bigserial PRIMARY KEY,
  keyword text NOT NULL,
  chat_id bigint NOT NULL,
  chat_type text,
  chat_title text,
  user_id bigint,
  username text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.usage_logs TO authenticated;
GRANT ALL ON public.usage_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.usage_logs_id_seq TO service_role;

ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role manages usage_logs"
  ON public.usage_logs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX idx_usage_logs_created_at ON public.usage_logs (created_at DESC);
CREATE INDEX idx_usage_logs_keyword ON public.usage_logs (keyword);
CREATE INDEX idx_usage_logs_chat_id ON public.usage_logs (chat_id);

-- Top keywords function
CREATE OR REPLACE FUNCTION public.get_keyword_stats(days integer DEFAULT 30, top_n integer DEFAULT 10)
RETURNS TABLE (keyword text, hits bigint, last_used timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT keyword, COUNT(*)::bigint AS hits, MAX(created_at) AS last_used
  FROM public.usage_logs
  WHERE created_at >= now() - (days || ' days')::interval
  GROUP BY keyword
  ORDER BY hits DESC
  LIMIT top_n;
$$;

-- Daily activity function
CREATE OR REPLACE FUNCTION public.get_daily_activity(days integer DEFAULT 14)
RETURNS TABLE (day date, hits bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::bigint AS hits
  FROM public.usage_logs
  WHERE created_at >= now() - (days || ' days')::interval
  GROUP BY 1
  ORDER BY 1;
$$;

-- Group activity function
CREATE OR REPLACE FUNCTION public.get_group_activity(days integer DEFAULT 30, top_n integer DEFAULT 10)
RETURNS TABLE (chat_id bigint, chat_title text, hits bigint, last_used timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT chat_id,
         COALESCE(MAX(chat_title), '(unknown)') AS chat_title,
         COUNT(*)::bigint AS hits,
         MAX(created_at) AS last_used
  FROM public.usage_logs
  WHERE created_at >= now() - (days || ' days')::interval
  GROUP BY chat_id
  ORDER BY hits DESC
  LIMIT top_n;
$$;

-- Overall stats function
CREATE OR REPLACE FUNCTION public.get_overall_stats()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total_hits', (SELECT COUNT(*) FROM public.usage_logs),
    'hits_today', (SELECT COUNT(*) FROM public.usage_logs WHERE created_at >= date_trunc('day', now())),
    'hits_7d', (SELECT COUNT(*) FROM public.usage_logs WHERE created_at >= now() - interval '7 days'),
    'hits_30d', (SELECT COUNT(*) FROM public.usage_logs WHERE created_at >= now() - interval '30 days'),
    'total_keywords', (SELECT COUNT(*) FROM public.replies),
    'total_groups', (SELECT COUNT(*) FROM public.tg_groups WHERE is_member = true),
    'active_groups_7d', (SELECT COUNT(DISTINCT chat_id) FROM public.usage_logs WHERE created_at >= now() - interval '7 days')
  );
$$;
