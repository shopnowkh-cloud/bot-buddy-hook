REVOKE EXECUTE ON FUNCTION public.prune_telegram_updates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_telegram_updates() TO service_role;