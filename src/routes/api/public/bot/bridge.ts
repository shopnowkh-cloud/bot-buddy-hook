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
  z.object({ action: z.literal("list_groups_all") }),
  z.object({ action: z.literal("leave_group"), chat_id: z.number().int() }),
  z.object({ action: z.literal("refresh_group"), chat_id: z.number().int() }),
  z.object({
    action: z.literal("send_to_group"),
    chat_id: z.number().int(),
    keyword: z.string().min(1).max(255),
  }),
  z.object({
    action: z.literal("broadcast_text"),
    text: z.string().min(1).max(4096),
    chat_ids: z.array(z.number().int()).min(1).max(500).optional(),
  }),
  z.object({
    action: z.literal("broadcast_keyword"),
    keyword: z.string().min(1).max(255),
    chat_ids: z.array(z.number().int()).min(1).max(500).optional(),
  }),
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
            case "list_schedules": {
              const { data, error } = await s
                .from("scheduled_messages")
                .select("*")
                .order("id", { ascending: false })
                .limit(500);
              if (error) return jerr(500, error.message);
              return jok({ schedules: data ?? [] });
            }
            case "list_groups": {
              const { data, error } = await s
                .from("tg_groups")
                .select("chat_id, title, is_member")
                .eq("is_member", true)
                .order("updated_at", { ascending: false })
                .limit(200);
              if (error) return jerr(500, error.message);
              return jok({ groups: data ?? [] });
            }
            case "create_schedule": {
              if (!req.repeat_daily && !req.scheduled_at) {
                return jerr(400, "scheduled_at required for one-time schedules");
              }
              if (req.repeat_daily && !req.daily_time) {
                return jerr(400, "daily_time required for daily schedules");
              }
              const { error } = await s.from("scheduled_messages").insert({
                keyword: req.keyword,
                group_chat_id: req.group_chat_id,
                group_title: req.group_title ?? null,
                repeat_daily: req.repeat_daily,
                daily_time: req.repeat_daily ? req.daily_time! : null,
                scheduled_at: req.repeat_daily ? null : req.scheduled_at!,
                enabled: true,
              });
              if (error) return jerr(500, error.message);
              return jok({ ok: true });
            }
            case "update_schedule": {
              const patch: any = {};
              if (req.keyword !== undefined) patch.keyword = req.keyword;
              if (req.group_chat_id !== undefined) patch.group_chat_id = req.group_chat_id;
              if (req.group_title !== undefined) patch.group_title = req.group_title;
              if (req.repeat_daily !== undefined) patch.repeat_daily = req.repeat_daily;
              if (req.daily_time !== undefined) patch.daily_time = req.daily_time;
              if (req.scheduled_at !== undefined) patch.scheduled_at = req.scheduled_at;
              if (req.enabled !== undefined) patch.enabled = req.enabled;
              const { error } = await s.from("scheduled_messages").update(patch).eq("id", req.id);
              if (error) return jerr(500, error.message);
              return jok({ ok: true });
            }
            case "delete_schedule": {
              const { error } = await s.from("scheduled_messages").delete().eq("id", req.id);
              if (error) return jerr(500, error.message);
              return jok({ ok: true });
            }
            case "toggle_schedule": {
              const { error } = await s
                .from("scheduled_messages")
                .update({ enabled: req.enabled })
                .eq("id", req.id);
              if (error) return jerr(500, error.message);
              return jok({ ok: true });
            }
            case "list_groups_all": {
              const { data, error } = await s
                .from("tg_groups")
                .select("chat_id, title, is_member, updated_at")
                .order("updated_at", { ascending: false })
                .limit(500);
              if (error) return jerr(500, error.message);
              return jok({ groups: data ?? [] });
            }
            case "leave_group": {
              const token = process.env.TELEGRAM_BOT_TOKEN;
              if (!token) return jerr(500, "TELEGRAM_BOT_TOKEN not configured");
              const { tgRequest } = await import("@/routes/api/public/telegram/webhook");
              const res = await tgRequest(token, "leaveChat", { chat_id: req.chat_id });
              await s
                .from("tg_groups")
                .update({ is_member: false, updated_at: new Date().toISOString() })
                .eq("chat_id", req.chat_id);
              if (!res?.ok) return jerr(500, res?.description ?? "leaveChat failed");
              return jok({ ok: true });
            }
            case "refresh_group": {
              const token = process.env.TELEGRAM_BOT_TOKEN;
              if (!token) return jerr(500, "TELEGRAM_BOT_TOKEN not configured");
              const { tgRequest } = await import("@/routes/api/public/telegram/webhook");
              const res = await tgRequest(token, "getChat", { chat_id: req.chat_id });
              if (!res?.ok) return jerr(500, res?.description ?? "getChat failed");
              await s.from("tg_groups").upsert(
                {
                  chat_id: req.chat_id,
                  title: res.result?.title ?? null,
                  is_member: true,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "chat_id" },
              );
              return jok({ ok: true, group: res.result });
            }
            case "send_to_group": {
              const token = process.env.TELEGRAM_BOT_TOKEN;
              if (!token) return jerr(500, "TELEGRAM_BOT_TOKEN not configured");
              const { data: reply, error } = await s
                .from("replies")
                .select("content, delete_after_seconds")
                .eq("keyword", req.keyword)
                .maybeSingle();
              if (error) return jerr(500, error.message);
              if (!reply) return jerr(404, "keyword not found");
              const { sendReplies, loadConfig } = await import("@/routes/api/public/telegram/webhook");
              const effective =
                reply.delete_after_seconds ?? (await loadConfig(s));
              await sendReplies(token, s, req.chat_id, reply.content, effective);
              return jok({ ok: true });
            }
            case "broadcast_text": {
              const token = process.env.TELEGRAM_BOT_TOKEN;
              if (!token) return jerr(500, "TELEGRAM_BOT_TOKEN not configured");
              const { tgRequest } = await import("@/routes/api/public/telegram/webhook");
              let chatIds = req.chat_ids ?? [];
              if (chatIds.length === 0) {
                const { data } = await s.from("tg_groups").select("chat_id").eq("is_member", true);
                chatIds = (data ?? []).map((g) => g.chat_id);
              }
              const results: { chat_id: number; ok: boolean; error?: string }[] = [];
              for (const cid of chatIds) {
                const res = await tgRequest(token, "sendMessage", { chat_id: cid, text: req.text });
                results.push({ chat_id: cid, ok: !!res?.ok, error: res?.ok ? undefined : res?.description });
              }
              return jok({ ok: true, sent: results.filter((r) => r.ok).length, total: results.length, results });
            }
            case "broadcast_keyword": {
              const token = process.env.TELEGRAM_BOT_TOKEN;
              if (!token) return jerr(500, "TELEGRAM_BOT_TOKEN not configured");
              const { data: reply, error } = await s
                .from("replies")
                .select("content, delete_after_seconds")
                .eq("keyword", req.keyword)
                .maybeSingle();
              if (error) return jerr(500, error.message);
              if (!reply) return jerr(404, "keyword not found");
              let chatIds = req.chat_ids ?? [];
              if (chatIds.length === 0) {
                const { data } = await s.from("tg_groups").select("chat_id").eq("is_member", true);
                chatIds = (data ?? []).map((g) => g.chat_id);
              }
              const { sendReplies, loadConfig } = await import("@/routes/api/public/telegram/webhook");
              const effective =
                reply.delete_after_seconds ?? (await loadConfig(s));
              const results: { chat_id: number; ok: boolean; error?: string }[] = [];
              for (const cid of chatIds) {
                try {
                  await sendReplies(token, s, cid, reply.content, effective);
                  results.push({ chat_id: cid, ok: true });
                } catch (e: any) {
                  results.push({ chat_id: cid, ok: false, error: e?.message });
                }
              }
              return jok({ ok: true, sent: results.filter((r) => r.ok).length, total: results.length, results });
            }
          }
        } catch (e: any) {
          return jerr(500, e?.message ?? "server error");
        }
      },
    },
  },
});
