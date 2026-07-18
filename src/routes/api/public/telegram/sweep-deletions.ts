import { createFileRoute } from "@tanstack/react-router";

// Cron-triggered sweep: deletes Telegram messages whose delete_at has passed.
// Called by pg_cron every minute via pg_net.
export const Route = createFileRoute("/api/public/telegram/sweep-deletions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Cron-only endpoint. Bounded, idempotent: only deletes messages
        // already scheduled in pending_deletions. If BOT_SYNC_SECRET header
        // is provided, validate it; otherwise allow (pg_cron via pg_net).
        const gate = process.env.BOT_SYNC_SECRET;
        const provided = request.headers.get("x-sync-secret");
        if (gate && provided && provided !== gate) {
          return new Response("Unauthorized", { status: 401 });
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
        const failed: Array<{ id: number; status: number; description: string }> = [];
        for (const row of due ?? []) {
          try {
            const response = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: row.chat_id, message_id: row.message_id }),
            });
            const result = (await response.json().catch(() => null)) as
              | { ok?: boolean; description?: string }
              | null;
            const description = result?.description ?? `HTTP ${response.status}`;
            const alreadyGone =
              response.status === 400 &&
              /message to delete not found|message can't be deleted/i.test(description);

            if ((response.ok && result?.ok) || alreadyGone) {
              processed.push(row.id as number);
            } else {
              failed.push({ id: row.id as number, status: response.status, description });
            }
          } catch (error) {
            failed.push({
              id: row.id as number,
              status: 0,
              description: error instanceof Error ? error.message : "Network error",
            });
          }
        }

        if (processed.length > 0) {
          await supabaseAdmin.from("pending_deletions").delete().in("id", processed);
        }

        if (failed.length > 0) console.error("Telegram deletion failures", failed);

        return new Response(JSON.stringify({
          ok: failed.length === 0,
          processed: processed.length,
          failed: failed.length,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
