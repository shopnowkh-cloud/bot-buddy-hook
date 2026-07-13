// Admin configuration helper: single source of truth for admin IDs and
// access tokens. Reads from public.admin_settings (managed via Mini App)
// and merges with env fallbacks (ADMIN_CHAT_ID, ADMIN_ACCESS_TOKEN) so
// bootstrap never breaks even when the table is empty.
//
// Server-only. Cached for 30s to keep the webhook hot path fast.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type AdminConfig = {
  adminIds: number[];
  accessTokens: string[];
};

let _client: SupabaseClient<Database> | null = null;
function sb(): SupabaseClient<Database> {
  if (!_client) {
    _client = createClient<Database>(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return _client;
}

let _cache: { at: number; cfg: AdminConfig } | null = null;
const CACHE_MS = 30_000;

function envFallback(): AdminConfig {
  const envId = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : NaN;
  const envToken = process.env.ADMIN_ACCESS_TOKEN ?? "";
  return {
    adminIds: Number.isFinite(envId) ? [envId] : [],
    accessTokens: envToken ? [envToken] : [],
  };
}

function mergeUnique(a: (number | string)[], b: (number | string)[]) {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const v of [...a, ...b]) {
    const k = String(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

export async function getAdminConfig(force = false): Promise<AdminConfig> {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < CACHE_MS) return _cache.cfg;

  const env = envFallback();
  try {
    const { data } = await sb()
      .from("admin_settings")
      .select("admin_ids, access_tokens")
      .eq("id", 1)
      .maybeSingle();
    const cfg: AdminConfig = {
      adminIds: mergeUnique(env.adminIds, (data?.admin_ids ?? []).map(Number)),
      accessTokens: mergeUnique(env.accessTokens, data?.access_tokens ?? []),
    };
    _cache = { at: now, cfg };
    return cfg;
  } catch {
    return env;
  }
}

export function invalidateAdminCache() {
  _cache = null;
}

export async function isAdminUserId(userId: number | undefined | null): Promise<boolean> {
  if (userId == null) return false;
  const cfg = await getAdminConfig();
  return cfg.adminIds.includes(Number(userId));
}

export async function isValidAccessToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const cfg = await getAdminConfig();
  return cfg.accessTokens.includes(token);
}

// Mutations — write to DB then bust cache.
export async function addAdminId(id: number) {
  const cfg = await getAdminConfig(true);
  const next = mergeUnique(cfg.adminIds, [id]) as number[];
  await upsert(next, cfg.accessTokens);
}

export async function removeAdminId(id: number) {
  const cfg = await getAdminConfig(true);
  const next = cfg.adminIds.filter((x) => Number(x) !== Number(id));
  await upsert(next, cfg.accessTokens);
}

export async function addAccessToken(t: string) {
  const cfg = await getAdminConfig(true);
  const next = mergeUnique(cfg.accessTokens, [t]) as string[];
  await upsert(cfg.adminIds, next);
}

export async function removeAccessToken(t: string) {
  const cfg = await getAdminConfig(true);
  const next = cfg.accessTokens.filter((x) => x !== t);
  await upsert(cfg.adminIds, next);
}

async function upsert(adminIds: number[], accessTokens: string[]) {
  // Persist only DB-managed values (exclude env fallback entries).
  const env = envFallback();
  const dbIds = adminIds.filter((x) => !env.adminIds.includes(Number(x)));
  const dbTokens = accessTokens.filter((x) => !env.accessTokens.includes(x));
  const { error } = await sb().from("admin_settings").upsert(
    { id: 1, admin_ids: dbIds, access_tokens: dbTokens, updated_at: new Date().toISOString() },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);
  invalidateAdminCache();
}
