import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "crypto";

// One-shot helper: (re)registers this project's webhook with Telegram using
// TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET from env. Safe/idempotent:
// it always sets the same URL + secret_token derived from server env.
export const Route = createFileRoute("/api/public/telegram/register-webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
        if (!token || !secret) {
          return new Response(
            JSON.stringify({ ok: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const url = new URL(request.url);
        const origin = url.origin;
        if (url.protocol !== "https:") {
          return new Response(
            JSON.stringify({ ok: false, error: "Webhook registration requires the HTTPS preview or published URL" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const webhookUrl = `${origin}/api/public/telegram/webhook`;
        const secretToken = createHash("sha256").update(secret).digest("hex");

        const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: secretToken,
            allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
            drop_pending_updates: true,
          }),
        });
        const tgJson = await tgRes.json().catch(() => ({}));

        // Auto-register the bot's slash-command menu (setMyCommands) so
        // clients see /keyword suggestions right after the webhook is set.
        let commandsSync: any = { ok: false, skipped: true };
        try {
          const { createClient } = await import("@supabase/supabase-js");
          const { syncBotCommands, resetCommandsSyncSignature, clearReplyCache } =
            await import("./webhook");
          const supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { persistSession: false, autoRefreshToken: false } },
          );
          clearReplyCache();
          resetCommandsSyncSignature();
          await syncBotCommands(token, supabase);
          commandsSync = { ok: true };
        } catch (err: any) {
          commandsSync = { ok: false, error: String(err?.message ?? err) };
        }

        const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        const infoJson = await infoRes.json().catch(() => ({}));

        return new Response(
          JSON.stringify(
            { ok: tgRes.ok, webhookUrl, setWebhook: tgJson, setMyCommands: commandsSync, info: infoJson },
            null,
            2,
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
