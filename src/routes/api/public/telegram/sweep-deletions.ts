import { createFileRoute } from "@tanstack/react-router";

// Cron-triggered sweep: deletes Telegram messages whose delete_at has passed.
// Called by pg_cron every minute via pg_net.
export const Route = createFileRoute("/api/public/telegram/sweep-deletions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = process.env.BOT_SYNC_SECRET;
        if (gate) {
          const provided = request.headers.get("x-sync-secret") ?? "";
          if (provided !== gate) return new Response("Unauthorized", { status: 401 });
        }
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return new Response("Bot not configured", { status: 500 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: due, error } = await supabaseAdmin
          .from("pending_deletions")
          .select("id, chat_id, message_id")
          .lte("delete_at", new Date().toISOString())
          .limit(200);

        if (error) {
          console.error("sweep query failed", error);
          return new Response(JSON.stringify({ ok: false }), { status: 500 });
        }

        const processed: number[] = [];
        for (const row of due ?? []) {
          await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: row.chat_id, message_id: row.message_id }),
          }).catch(() => {});
          processed.push(row.id as number);
        }

        if (processed.length > 0) {
          await supabaseAdmin.from("pending_deletions").delete().in("id", processed);
        }

        return new Response(JSON.stringify({ ok: true, processed: processed.length }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
