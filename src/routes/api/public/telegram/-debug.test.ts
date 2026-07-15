import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/admin-config.server", () => ({
  isAdminUserId: vi.fn(async (id: any) => Number(id) === 1),
}));

const holder: { current: any } = { current: null };
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() { console.log("[getter called]", !!holder.current); return holder.current; },
}));

import { Route } from "./webhook";

it("debug", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "TOKEN";
  process.env.ADMIN_CHAT_ID = "1";
  process.env.TELEGRAM_WEBHOOK_SECRET = "SECRET";
  process.env.SUPABASE_URL = "http://l";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";

  const fetchSpy = vi.fn(async (url: string, init: any) => {
    console.log("[fetch]", url, init?.body?.slice?.(0, 100));
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);

  holder.current = {
    from: () => ({
      select: () => ({ order: () => ({ order: () => Promise.resolve({ data: [{ keyword: "hi", content: {type:"text",content:"y"}, delete_after_seconds: null }] }) }), eq: () => ({ maybeSingle: () => Promise.resolve({ data: { delete_after_seconds: 0 } }) }) }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    }),
  };

  const { createHash } = require("crypto");
  const sec = createHash("sha256").update("telegram-webhook:SECRET").digest("base64url");
  const req = new Request("http://l/w", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": sec },
    body: JSON.stringify({ update_id: 1, message: { chat: { id: 42, type: "private" }, from: { id: 999 }, message_id: 1, text: "hi" } }),
  });
  const handler = (Route as any).options.server.handlers.POST;
  const res = await handler({ request: req });
  console.log("[status]", res.status);
  await new Promise((r) => setTimeout(r, 100));
  console.log("[fetch calls]", fetchSpy.mock.calls.length);
  expect(true).toBe(true);
});
