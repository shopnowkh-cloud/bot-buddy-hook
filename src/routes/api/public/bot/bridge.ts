import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

// Bridge endpoint called by the external Mini App Worker (deployed on the
// user's own Cloudflare account). Same logic as the retired
// /api/public/miniapp/api route, but gated by a shared BOT_SYNC_SECRET
// instead of being publicly open.

let _supabase: ReturnType<typeof createClient<Database>> | null = null;
function sb() {
  if (!_supabase) {
    _supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

async function invalidateAndSyncCommands() {
  try {
    const { clearReplyCache, resetCommandsSyncSignature, syncBotCommands } = await import(
      "@/routes/api/public/telegram/webhook"
    );
    clearReplyCache();
    resetCommandsSyncSignature();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) await syncBotCommands(token, sb()).catch(() => {});
  } catch {}
}

const ContentItem = z.object({
  type: z.enum(["text", "photo", "video", "audio", "voice", "document", "animation", "sticker"]),
  text: z.string().max(4096).optional(),
  file_id: z.string().max(512).optional(),
  caption: z.string().max(1024).optional(),
});

const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("me") }),
  z.object({ action: z.literal("stats") }),
  z.object({ action: z.literal("list_replies") }),
  z.object({ action: z.literal("list_pending") }),
  z.object({ action: z.literal("get_config") }),
  z.object({
    action: z.literal("set_global_timer"),
    delete_after_seconds: z.number().int().min(0).max(86400),
  }),
  z.object({
    action: z.literal("upsert_reply"),
    keyword: z.string().min(1).max(255),
    content: z.array(ContentItem).min(1).max(20),
    delete_after_seconds: z.number().int().min(0).max(86400).nullable().optional(),
  }),
  z.object({
    action: z.literal("set_keyword_timer"),
    keyword: z.string().min(1).max(255),
    delete_after_seconds: z.number().int().min(0).max(86400).nullable(),
  }),
  z.object({ action: z.literal("delete_reply"), keyword: z.string().min(1).max(255) }),
  z.object({ action: z.literal("clear_pending") }),
  z.object({
    action: z.literal("reorder_replies"),
    keywords: z.array(z.string().min(1).max(255)).min(1).max(500),
  }),
  z.object({
    action: z.literal("reorder_replies_grid"),
    rows: z.array(z.array(z.string().min(1).max(255)).min(1).max(8)).min(1).max(200),
  }),
  z.object({ action: z.literal("list_admins") }),
  z.object({ action: z.literal("add_admin_id"), admin_id: z.number().int().positive() }),
  z.object({ action: z.literal("remove_admin_id"), admin_id: z.number().int().positive() }),
  z.object({ action: z.literal("analytics_overview") }),
  z.object({
    action: z.literal("analytics_top_keywords"),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    action: z.literal("analytics_daily"),
    days: z.number().int().min(1).max(90).optional(),
  }),
  z.object({
    action: z.literal("analytics_groups"),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ action: z.literal("list_schedules") }),
  z.object({ action: z.literal("list_groups") }),
  z.object({
    action: z.literal("create_schedule"),
    keyword: z.string().min(1).max(255),
    group_chat_id: z.number().int(),
    group_title: z.string().max(255).nullable().optional(),
    repeat_daily: z.boolean(),
    daily_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    scheduled_at: z.string().datetime().nullable().optional(),
  }),
  z.object({
    action: z.literal("update_schedule"),
    id: z.number().int().positive(),
    keyword: z.string().min(1).max(255).optional(),
    group_chat_id: z.number().int().optional(),
    group_title: z.string().max(255).nullable().optional(),
    repeat_daily: z.boolean().optional(),
    daily_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    scheduled_at: z.string().datetime().nullable().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ action: z.literal("delete_schedule"), id: z.number().int().positive() }),
  z.object({ action: z.literal("toggle_schedule"), id: z.number().int().positive(), enabled: z.boolean() }),
]);

function jerr(status: number, msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-bridge-secret, x-init-data, x-admin-token",
    "Access-Control-Max-Age": "86400",
  } as Record<string, string>;
}

function timingSafeStrEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/bot/bridge")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
      POST: async ({ request }) => {
        const expected = process.env.BOT_SYNC_SECRET;
        if (!expected) return jerr(500, "BOT_SYNC_SECRET not configured");
        const provided = request.headers.get("x-bridge-secret") ?? "";
        if (!timingSafeStrEq(provided, expected)) return jerr(401, "unauthorized");

        // ---- End-user auth: verify Telegram Mini App initData OR a valid access token ----
        // Prevents random visitors of the Worker URL from acting as admin.
        const initData = request.headers.get("x-init-data") ?? "";
        const adminTokenHeader = request.headers.get("x-admin-token") ?? "";
        let authOk = false;
        let authUserId: number | undefined;

        if (adminTokenHeader) {
          const { isValidAccessToken } = await import("@/lib/admin-config.server");
          if (await isValidAccessToken(adminTokenHeader)) authOk = true;
        }
        if (!authOk && initData) {
          const botToken = process.env.TELEGRAM_BOT_TOKEN;
          if (botToken) {
            const { verifyInitData } = await import("@/lib/telegram-initdata.server");
            const v = verifyInitData(initData, botToken);
            if (v.ok && v.user?.id) {
              const { isAdminUserId } = await import("@/lib/admin-config.server");
              if (await isAdminUserId(v.user.id)) {
                authOk = true;
                authUserId = v.user.id;
              }
            }
          }
        }
        if (!authOk) return jerr(401, "not an admin (missing valid initData or access token)");

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jerr(400, "invalid json");
        }
        const parsed = RequestSchema.safeParse(body);
        if (!parsed.success) return jerr(400, parsed.error.message);
        const req = parsed.data;
        const s = sb();
        void authUserId;

        const jok = (data: unknown) =>
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders() },
          });

        try {
          switch (req.action) {
            case "me":
              return jok({ user: { id: 0, first_name: "Admin", username: "admin" } });
            case "stats": {
              const [{ count: replies }, { count: pending }, { data: cfg }] = await Promise.all([
                s.from("replies").select("*", { count: "exact", head: true }),
                s.from("pending_deletions").select("*", { count: "exact", head: true }),
                s.from("bot_config").select("delete_after_seconds").eq("id", 1).maybeSingle(),
              ]);
              return jok({
                replies_count: replies ?? 0,
                pending_count: pending ?? 0,
                global_timer: cfg?.delete_after_seconds ?? 0,
              });
            }
            case "list_replies": {
              const { data, error } = await s
                .from("replies")
                .select("keyword, content, delete_after_seconds, updated_at, position, row_index")
                .order("row_index", { ascending: true })
                .order("position", { ascending: true })
                .order("created_at", { ascending: true });
              if (error) return jerr(500, error.message);
              return jok({ replies: data ?? [] });
            }
            case "list_pending": {
              const { data, error } = await s
                .from("pending_deletions")
                .select("id, chat_id, message_id, delete_at, created_at")
                .order("delete_at", { ascending: true })
                .limit(200);
              if (error) return jerr(500, error.message);
              return jok({ pending: data ?? [] });
            }
            case "get_config": {
              const { data } = await s.from("bot_config").select("*").eq("id", 1).maybeSingle();
              return jok({ config: data ?? { delete_after_seconds: 0 } });
            }
            case "set_global_timer": {
              const { error } = await s
                .from("bot_config")
                .upsert(
                  { id: 1, delete_after_seconds: req.delete_after_seconds, updated_at: new Date().toISOString() },
                  { onConflict: "id" },
                );
              if (error) return jerr(500, error.message);
              return jok({ ok: true });
            }
            case "upsert_reply": {
              const { error } = await s.from("replies").upsert(
                {
                  keyword: req.keyword,
                  content: req.content,
                  delete_after_seconds: req.delete_after_seconds ?? null,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "keyword" },
              );
              if (error) return jerr(500, error.message);
              await invalidateAndSyncCommands();
              return jok({ ok: true });
            }
            case "set_keyword_timer": {
              const { error } = await s
                .from("replies")
                .update({
                  delete_after_seconds: req.delete_after_seconds,
                  updated_at: new Date().toISOString(),
                })
                .eq("keyword", req.keyword);
              if (error) return jerr(500, error.message);
              await invalidateAndSyncCommands();
              return jok({ ok: true });
            }
            case "delete_reply": {
              const { error } = await s.from("replies").delete().eq("keyword", req.keyword);
              if (error) return jerr(500, error.message);
              await invalidateAndSyncCommands();
              return jok({ ok: true });
            }
            case "clear_pending": {
              const { error } = await s.from("pending_deletions").delete().neq("id", -1);
              if (error) return jerr(500, error.message);
              return jok({ ok: true });
            }
            case "reorder_replies": {
              const now = new Date().toISOString();
              const updates = req.keywords.map((keyword, i) =>
                s.from("replies").update({ row_index: i + 1, position: (i + 1) * 10, updated_at: now }).eq("keyword", keyword),
              );
              const results = await Promise.all(updates);
              const firstErr = results.find((r) => r.error);
              if (firstErr?.error) return jerr(500, firstErr.error.message);
              await invalidateAndSyncCommands();
              return jok({ ok: true });
            }
            case "reorder_replies_grid": {
              const now = new Date().toISOString();
              const updates: any[] = [];
              req.rows.forEach((row, rIdx) => {
                row.forEach((keyword, cIdx) => {
                  updates.push(
                    s.from("replies")
                      .update({ row_index: rIdx + 1, position: (cIdx + 1) * 10, updated_at: now })
                      .eq("keyword", keyword),
                  );
                });
              });
              const results = await Promise.all(updates);
              const firstErr = results.find((r) => r.error);
              if (firstErr?.error) return jerr(500, firstErr.error.message);
              await invalidateAndSyncCommands();
              return jok({ ok: true });
            }
            case "list_admins": {
              const { getAdminConfig } = await import("@/lib/admin-config.server");
              const cfg = await getAdminConfig(true);
              const envIds = process.env.ADMIN_CHAT_ID ? [Number(process.env.ADMIN_CHAT_ID)] : [];
              return jok({
                admin_ids: cfg.adminIds.map((id) => ({
                  id,
                  from_env: envIds.includes(Number(id)),
                })),
              });
            }
            case "add_admin_id": {
              const { addAdminId } = await import("@/lib/admin-config.server");
              await addAdminId(req.admin_id);
              return jok({ ok: true });
            }
            case "remove_admin_id": {
              const envIds = process.env.ADMIN_CHAT_ID ? [Number(process.env.ADMIN_CHAT_ID)] : [];
              if (envIds.includes(Number(req.admin_id))) {
                return jerr(400, "cannot remove env-managed admin (edit ADMIN_CHAT_ID secret)");
              }
              const { removeAdminId } = await import("@/lib/admin-config.server");
              await removeAdminId(req.admin_id);
              return jok({ ok: true });
            }
            case "analytics_overview": {
              const { data, error } = await s.rpc("get_overall_stats");
              if (error) return jerr(500, error.message);
              return jok({ overview: data ?? {} });
            }
            case "analytics_top_keywords": {
              const { data, error } = await s.rpc("get_keyword_stats", {
                days: req.days ?? 30,
                top_n: req.limit ?? 10,
              });
              if (error) return jerr(500, error.message);
              return jok({ keywords: data ?? [] });
            }
            case "analytics_daily": {
              const { data, error } = await s.rpc("get_daily_activity", {
                days: req.days ?? 14,
              });
              if (error) return jerr(500, error.message);
              return jok({ daily: data ?? [] });
            }
            case "analytics_groups": {
              const { data, error } = await s.rpc("get_group_activity", {
                days: req.days ?? 30,
                top_n: req.limit ?? 10,
              });
              if (error) return jerr(500, error.message);
              return jok({ groups: data ?? [] });
            }
          }
        } catch (e: any) {
          return jerr(500, e?.message ?? "server error");
        }
      },
    },
  },
});
