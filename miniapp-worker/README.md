# Mini App Worker — Standalone Cloudflare Worker Deployment

This is the Telegram Mini App Admin Dashboard, extracted from the Lovable bot
project so it can be deployed independently to **your own Cloudflare account**.

The bot itself (Telegram webhook, message handling, cron sweeps) still runs on
Lovable. This Worker only hosts the admin UI and proxies its data requests
through an authenticated bridge endpoint on the bot.

## Architecture

```
Admin browser ─► your-worker.workers.dev / custom domain (this Worker)
                    │  serves SPA static assets
                    └► POST /api/miniapp
                          │ adds X-Bridge-Secret: $BOT_SYNC_SECRET
                          ▼
                       bot-buddy-hook.lovable.app/api/public/bot/bridge
                          │ (validates secret, uses Supabase service role)
                          ▼
                       Supabase + Telegram setMyCommands
```

## Prerequisites

1. **Cloudflare account** with a Workers-enabled plan (the free plan works)
2. **Cloudflare API token** with `Account.Workers Scripts:Edit` permission
3. **Bun** (or npm/pnpm) installed locally
4. **Wrangler**, installed automatically by `bun install`

## One-time setup

```bash
cd miniapp-worker
bun install
```

Log in Wrangler with your API token:

```bash
export CLOUDFLARE_API_TOKEN=<your-new-token>
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
```

Set the two Worker secrets (Wrangler will prompt for values):

```bash
bunx wrangler secret put BOT_SYNC_URL
# paste: https://bot-buddy-hook.lovable.app/api/public/bot/bridge

bunx wrangler secret put BOT_SYNC_SECRET
# paste: the exact same value you set for BOT_SYNC_SECRET on Lovable
```

## Deploy

```bash
bun run deploy
```

That runs `vite build` (SPA into `dist/`) and `wrangler deploy` (uploads the
Worker + assets). Your Mini App will be live at
`https://miniapp-worker.<your-subdomain>.workers.dev`.

## Custom domain

1. Cloudflare Dashboard → Workers & Pages → `miniapp-worker` → **Settings**
2. **Domains & Routes** → **Add** → **Custom Domain**
3. Enter your subdomain (e.g. `admin.yourdomain.com`)
4. Cloudflare handles DNS + SSL automatically if the zone is on Cloudflare

## Local dev

```bash
bun run dev
```

Runs Vite on `http://localhost:5173`. `/api/miniapp` is proxied to
`https://bot-buddy-hook.lovable.app/api/public/bot/bridge` — but you still need
to send the shared secret, so local dev of mutating actions requires running
the Worker itself in front:

```bash
# terminal 1
bun run build && bunx wrangler dev
```

## Configure the Telegram Mini App button

In BotFather, update your Mini App URL to point to the new Worker URL (or your
custom domain) instead of the old `bot-buddy-hook.lovable.app/miniapp`.

## Security note

`BOT_SYNC_SECRET` is the only guard on the bridge endpoint. Treat it like a
password. Rotate by running `wrangler secret put BOT_SYNC_SECRET` on the Worker
and updating the Lovable secret with the same value.
