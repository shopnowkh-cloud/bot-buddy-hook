
REVOKE EXECUTE ON FUNCTION public.get_keyword_stats(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_daily_activity(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_group_activity(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_overall_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_keyword_stats(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_daily_activity(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_group_activity(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_overall_stats() TO service_role;
