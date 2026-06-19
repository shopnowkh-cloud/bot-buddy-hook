import { createFileRoute } from "@tanstack/react-router";

// Phnom Penh = UTC+7, no DST.
const PP_OFFSET_MS = 7 * 60 * 60 * 1000;

async function tgSend(token: string, method: string, body: any) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => null);
}

async function sendKeywordToGroup(
  token: string,
  supabase: any,
  keyword: string,
  groupId: number,
) {
  const { data: row } = await supabase
    .from("replies")
    .select("content")
    .eq("keyword", keyword)
    .maybeSingle();
  if (!row) return false;
  const list = Array.isArray(row.content) ? row.content : [row.content];
  for (const item of list) {
    if (item?.type === "copy") {
      const method = item.forward ? "forwardMessage" : "copyMessage";
      await tgSend(token, method, {
        chat_id: groupId,
        from_chat_id: item.from_chat_id,
        message_id: item.message_id,
      });
    } else if (item?.type === "text") {
      await tgSend(token, "sendMessage", { chat_id: groupId, text: item.content });
    }
  }
  return true;
}

// Cron-triggered: send due scheduled messages every minute.
export const Route = createFileRoute("/api/public/telegram/sweep-schedules")({
  server: {
    handlers: {
      POST: async () => {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return new Response("Bot not configured", { status: 500 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: rows, error } = await supabaseAdmin
          .from("scheduled_messages")
          .select("*")
          .eq("enabled", true)
          .limit(500);
        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
        }

        const now = new Date();
        const ppNow = new Date(now.getTime() + PP_OFFSET_MS); // shifted clock
        const ppHHMM = ppNow.toISOString().slice(11, 16); // "HH:MM"
        const ppYMD = ppNow.toISOString().slice(0, 10);

        let sent = 0;
        for (const r of rows ?? []) {
          let due = false;
          if (r.repeat_daily) {
            if (!r.daily_time) continue;
            // Due if today's PP time >= scheduled time AND we haven't sent today.
            if (r.daily_time <= ppHHMM) {
              const lastSent = r.last_sent_at ? new Date(r.last_sent_at) : null;
              const lastPpYmd = lastSent
                ? new Date(lastSent.getTime() + PP_OFFSET_MS).toISOString().slice(0, 10)
                : null;
              if (lastPpYmd !== ppYMD) due = true;
            }
          } else {
            if (r.scheduled_at && new Date(r.scheduled_at).getTime() <= now.getTime()) due = true;
          }
          if (!due) continue;

          const ok = await sendKeywordToGroup(
            token,
            supabaseAdmin,
            r.keyword,
            Number(r.group_chat_id),
          );
          if (ok) sent++;

          const upd: any = { last_sent_at: now.toISOString() };
          if (!r.repeat_daily) upd.enabled = false; // one-time done
          await supabaseAdmin.from("scheduled_messages").update(upd).eq("id", r.id);
        }

        return new Response(JSON.stringify({ ok: true, sent }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
