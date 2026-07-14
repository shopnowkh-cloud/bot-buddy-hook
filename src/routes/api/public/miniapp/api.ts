import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

let _supabase: ReturnType<typeof createClient<Database>> | null = null;
function sb() {
  if (!_supabase) {
    _supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
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
]);

function jerr(status: number, msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/miniapp/api")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Open access — Mini App is public, no auth required.
        const v = { ok: true as const, user: { id: 0, first_name: "Admin", username: "admin" } };

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

        try {
          switch (req.action) {
            case "me":
              return Response.json({ user: v.user });
            case "stats": {
              const [{ count: replies }, { count: pending }, { data: cfg }] = await Promise.all([
                s.from("replies").select("*", { count: "exact", head: true }),
                s.from("pending_deletions").select("*", { count: "exact", head: true }),
                s.from("bot_config").select("delete_after_seconds").eq("id", 1).maybeSingle(),
              ]);
              return Response.json({
                replies_count: replies ?? 0,
                pending_count: pending ?? 0,
                global_timer: cfg?.delete_after_seconds ?? 0,
              });
            }
            case "list_replies": {
              const { data, error } = await s
                .from("replies")
                .select("keyword, content, delete_after_seconds, updated_at, position")
                .order("position", { ascending: true })
                .order("created_at", { ascending: true });
              if (error) return jerr(500, error.message);
              return Response.json({ replies: data ?? [] });
            }
            case "list_pending": {
              const { data, error } = await s
                .from("pending_deletions")
                .select("id, chat_id, message_id, delete_at, created_at")
                .order("delete_at", { ascending: true })
                .limit(200);
              if (error) return jerr(500, error.message);
              return Response.json({ pending: data ?? [] });
            }
            case "get_config": {
              const { data } = await s.from("bot_config").select("*").eq("id", 1).maybeSingle();
              return Response.json({ config: data ?? { delete_after_seconds: 0 } });
            }
            case "set_global_timer": {
              const { error } = await s
                .from("bot_config")
                .upsert(
                  { id: 1, delete_after_seconds: req.delete_after_seconds, updated_at: new Date().toISOString() },
                  { onConflict: "id" },
                );
              if (error) return jerr(500, error.message);
              return Response.json({ ok: true });
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
              return Response.json({ ok: true });
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
              return Response.json({ ok: true });
            }
            case "delete_reply": {
              const { error } = await s.from("replies").delete().eq("keyword", req.keyword);
              if (error) return jerr(500, error.message);
              return Response.json({ ok: true });
            }
            case "clear_pending": {
              const { error } = await s.from("pending_deletions").delete().neq("id", -1);
              if (error) return jerr(500, error.message);
              return Response.json({ ok: true });
            }
            case "reorder_replies": {
              const now = new Date().toISOString();
              const updates = req.keywords.map((keyword, i) =>
                s.from("replies").update({ position: (i + 1) * 10, updated_at: now }).eq("keyword", keyword),
              );
              const results = await Promise.all(updates);
              const firstErr = results.find((r) => r.error);
              if (firstErr?.error) return jerr(500, firstErr.error.message);
              return Response.json({ ok: true });
            }
            case "list_admins": {
              const { getAdminConfig } = await import("@/lib/admin-config.server");
              const cfg = await getAdminConfig(true);
              const envIds = process.env.ADMIN_CHAT_ID ? [Number(process.env.ADMIN_CHAT_ID)] : [];
              return Response.json({
                admin_ids: cfg.adminIds.map((id) => ({
                  id,
                  from_env: envIds.includes(Number(id)),
                })),
              });
            }
            case "add_admin_id": {
              const { addAdminId } = await import("@/lib/admin-config.server");
              await addAdminId(req.admin_id);
              return Response.json({ ok: true });
            }
            case "remove_admin_id": {
              const envIds = process.env.ADMIN_CHAT_ID ? [Number(process.env.ADMIN_CHAT_ID)] : [];
              if (envIds.includes(Number(req.admin_id))) {
                return jerr(400, "cannot remove env-managed admin (edit ADMIN_CHAT_ID secret)");
              }
              const { removeAdminId } = await import("@/lib/admin-config.server");
              await removeAdminId(req.admin_id);
              return Response.json({ ok: true });
            }
          }
        } catch (e: any) {
          return jerr(500, e?.message ?? "server error");
        }
      },
    },
  },
});
