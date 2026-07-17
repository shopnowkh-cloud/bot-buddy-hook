#!/usr/bin/env node
/**
 * Verify Telegram bot is running on webhook (not long polling).
 *
 * Usage:
 *   LOVABLE_API_KEY=... TELEGRAM_API_KEY=... \
 *   WEBHOOK_URL=https://bot-buddy-hook.lovable.app/api/public/telegram/webhook \
 *   node scripts/verify-webhook.mjs
 *
 * Checks:
 *  1. getWebhookInfo → url matches WEBHOOK_URL (webhook is registered)
 *  2. getUpdates    → returns 409 Conflict (proves long polling is blocked)
 *  3. POST webhook without secret → 401 (endpoint enforces auth)
 *  4. POST webhook with derived secret → 200 (endpoint is live)
 */
import { createHash } from "node:crypto";

const GATEWAY = "https://connector-gateway.lovable.dev/telegram";
const { LOVABLE_API_KEY, TELEGRAM_API_KEY, WEBHOOK_URL } = process.env;

if (!LOVABLE_API_KEY || !TELEGRAM_API_KEY || !WEBHOOK_URL) {
  console.error("Missing env: LOVABLE_API_KEY, TELEGRAM_API_KEY, WEBHOOK_URL");
  process.exit(2);
}

const tgHeaders = {
  Authorization: `Bearer ${LOVABLE_API_KEY}`,
  "X-Connection-Api-Key": TELEGRAM_API_KEY,
  "Content-Type": "application/json",
};

const secret = createHash("sha256")
  .update(`telegram-webhook:${TELEGRAM_API_KEY}`)
  .digest("base64url");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

// 1. getWebhookInfo
const info = await fetch(`${GATEWAY}/getWebhookInfo`, {
  method: "POST", headers: tgHeaders, body: "{}",
}).then(r => r.json());
const url = info?.result?.url ?? "";
check("getWebhookInfo.url matches", url === WEBHOOK_URL, `got "${url}"`);
check("pending_update_count is finite", typeof info?.result?.pending_update_count === "number",
  `${info?.result?.pending_update_count}`);
if (info?.result?.last_error_message) {
  console.log(`⚠️  last_error_message: ${info.result.last_error_message}`);
}

// 2. getUpdates must fail with 409 Conflict when a webhook is set
const upd = await fetch(`${GATEWAY}/getUpdates`, {
  method: "POST", headers: tgHeaders, body: JSON.stringify({ timeout: 0 }),
}).then(r => r.json());
check(
  "getUpdates blocked (long polling disabled)",
  upd?.ok === false && upd?.error_code === 409,
  `ok=${upd?.ok} code=${upd?.error_code} desc=${upd?.description ?? ""}`,
);

// 3. POST webhook without secret → 401
const noAuth = await fetch(WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ update_id: 1 }),
});
check("webhook rejects missing secret", noAuth.status === 401, `status=${noAuth.status}`);

// 4. POST webhook with derived secret → 200
const ok = await fetch(WEBHOOK_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Telegram-Bot-Api-Secret-Token": secret,
  },
  body: JSON.stringify({ update_id: Date.now() }), // ignored (no message)
});
check("webhook accepts valid secret", ok.status === 200, `status=${ok.status}`);

console.log(failed === 0 ? "\n✅ All checks passed — bot is on webhook, not polling." :
  `\n❌ ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
