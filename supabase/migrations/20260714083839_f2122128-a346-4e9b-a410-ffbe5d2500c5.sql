ALTER TABLE public.replies ADD COLUMN IF NOT EXISTS row_index integer NOT NULL DEFAULT 0;
UPDATE public.replies SET row_index = position WHERE row_index = 0;
CREATE INDEX IF NOT EXISTS replies_row_pos_idx ON public.replies(row_index, position);