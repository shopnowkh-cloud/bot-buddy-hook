
ALTER TABLE public.replies ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
WITH ranked AS (
  SELECT keyword, ROW_NUMBER() OVER (ORDER BY created_at) * 10 AS pos
  FROM public.replies
)
UPDATE public.replies r SET position = ranked.pos
FROM ranked WHERE r.keyword = ranked.keyword AND r.position = 0;
CREATE INDEX IF NOT EXISTS replies_position_idx ON public.replies(position);
