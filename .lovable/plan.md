
# ការបំបែក Mini App ទៅ Cloudflare Worker ដាច់ដោយឡែក

## ⚠️ សូមរ៉ូតេត Cloudflare Token ភ្លាមៗ
អ្នកបានចែក token និង account ID ក្នុង chat។ សូមទៅ **Cloudflare Dashboard → My Profile → API Tokens** ចុច **Roll** លើ token នោះឥឡូវនេះ ហើយបង្កើតថ្មី។ ខ្ញុំនឹងមិនប្រើ token ដែលអ្នកបានបិទភ្ជាប់នេះទេ។

## ⚠️ អ្វីដែល Lovable មិនអាចធ្វើដោយស្វ័យប្រវត្តិ
Lovable **មិនអាច deploy ទៅ Cloudflare account ខាងក្រៅរបស់អ្នកបានទេ** — Lovable ដេប្លយទៅ Cloudflare infrastructure ខាងក្នុងខ្លួន។ ដូច្នេះការ deploy ជាក់ស្ដែងទៅ Worker របស់អ្នកនឹងត្រូវ រត់ `wrangler deploy` ដោយ​អ្នក​ផ្ទាល់ (មួយ​ដង​ក្នុង​ terminal ឬ​​តាម GitHub Actions)។ ខ្ញុំរៀបចំ code, config, និងសេចក្ដីណែនាំ​ឲ្យ​ត្រៀម​សម្រាប់​ដេប្លយ។

---

## អ្វីខ្ញុំនឹងធ្វើ

### 1. បង្កើត folder ថ្មី `miniapp-worker/` ក្នុង repo នេះ
Standalone Cloudflare Worker project ដែលមាន៖
- **Frontend**: Vite + React build នៃ Mini App UI (យក `src/routes/miniapp.tsx` មកប្រែជា SPA)
- **API endpoint**: `POST /api/miniapp` (យក logic ពី `src/routes/api/public/miniapp/api.ts`)
- **wrangler.toml**: config សម្រាប់ Worker + static assets + secrets bindings
- **package.json + tsconfig**: dependencies (hono/itty-router, @supabase/supabase-js, react, vite)
- **README.md**: ជំហាន deploy ជា​ជំហានៗ

### 2. រៀបចំ HTTP bridge ទៅ bot នៅលើ Lovable
ព្រោះ Mini App លែងអាចហៅ `syncBotCommands` ដោយផ្ទាល់៖
- បន្ថែម endpoint ថ្មី `POST /api/public/bot/sync-commands` នៅលើ bot (Lovable side) ការពារដោយ shared secret
- Mini App Worker បញ្ជូន HTTP request ទៅ endpoint នេះបន្ទាប់ពី keyword mutations
- Bot នៅតែធ្វើ auto-sync លើ webhook updates ដដែល

### 3. Secrets ត្រូវរៀបចំក្នុង Cloudflare Worker (អ្នកកំណត់ដោយ​ខ្លួន)
```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
BOT_SYNC_URL         (https://bot-buddy-hook.lovable.app/api/public/bot/sync-commands)
BOT_SYNC_SECRET      (shared secret)
```
រត់៖ `wrangler secret put <NAME>` សម្រាប់​នីមួយ​ៗ។

### 4. Secret ថ្មីនៅ Lovable side
`BOT_SYNC_SECRET` — តម្លៃដូចគ្នានឹង Worker។ ខ្ញុំនឹងហៅ `add_secret` អោយ​អ្នក​បញ្ចូល។

### 5. លុប Mini App ចេញពី Lovable project
- លុប `src/routes/miniapp.tsx`
- លុប `src/routes/api/public/miniapp/api.ts`
- Bot នៅតែធម្មតា (webhook, sweep, register-webhook មិនកែ)

### 6. Custom domain
បន្ទាប់ពី `wrangler deploy` រួច អ្នកភ្ជាប់ custom domain ដោយ៖
- **Cloudflare Dashboard → Workers & Pages → [your worker] → Settings → Triggers → Custom Domains**
- បន្ថែម domain (ឧ. `admin.yourdomain.com`) — Cloudflare គ្រប់គ្រង DNS + SSL ដោយស្វ័យប្រវត្តិ​ប្រសិន​បើ domain host នៅ Cloudflare។

---

## ជំហានដេប្លយ (អ្នកនឹងធ្វើ​បន្ទាប់​ពី​ខ្ញុំ​សរសេរ​ code)
```bash
cd miniapp-worker
bun install
bun run build

# ដាក់ token
export CLOUDFLARE_API_TOKEN=<token ថ្មី​របស់​អ្នក​ក្រោយ​ពី​ roll>
export CLOUDFLARE_ACCOUNT_ID=<account id>

# ដាក់ secrets
bunx wrangler secret put SUPABASE_URL
bunx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
bunx wrangler secret put BOT_SYNC_URL
bunx wrangler secret put BOT_SYNC_SECRET

# deploy
bunx wrangler deploy
```

---

## Technical details

**Architecture after split:**
```text
User ─► admin.yourdomain.com (CF Worker)  ──► Supabase (RLS bypassed via service role)
                                          └─► Lovable bot /api/public/bot/sync-commands ──► Telegram setMyCommands
Telegram ─► bot-buddy-hook.lovable.app/api/public/telegram/webhook (Lovable, unchanged)
```

**Worker stack**: Hono for routing (small, Worker-native), Vite for building the React SPA to static assets served via `[assets]` binding in wrangler.toml.

**⚠️ បញ្ហាដែលត្រូវ​ដឹង៖ Supabase Service Role Key**
Service role key **មិន​អាច​យក​ចេញ​ពី Lovable Cloud** បាន — ខ្ញុំ​ក៏​មិន​អាច​ឆ្លុះ​វា​ឲ្យ​អ្នក​ដែរ​។ ដូច្នេះ Mini App Worker ខាងក្រៅ​ត្រូវ​តែ​ប្រើ **anon key + auth JWT** (ដូច​ជា​ការ login) ជំនួស service role, ឬ​អ្នក​ត្រូវ**បង្កើត Supabase project ដាច់ដោយឡែក​របស់​អ្នក​ផ្ទាល់** (ក្រៅ Lovable Cloud) ដែល​ចែក​តារាង​ដដែល ដើម្បី​យក service role key មក​ដាក់​ក្នុង Worker។

សូម​ជ្រើសរើស​មួយ​ក្នុង​ចំណោម​៖
- **A**: Mini App Worker ហៅ Supabase តាម **anon key + RLS policies** (គ្មាន bypass) — ត្រូវ​សរសេរ RLS policies សម្រាប់ admin auth
- **B**: Mini App Worker ហៅតែ **bridge endpoint​ថ្មី​របស់ bot** (បន្ថែម​នៅ Lovable) សម្រាប់​គ្រប់ read/write — Worker គ្មាន Supabase credentials​ទាំង​អស់, សាមញ្ញ​ជាង
- **C**: អ្នក migrate ទាំង​អស់​ទៅ Supabase project ខាង​ក្រៅ​ថ្មី​របស់​អ្នក

**ខ្ញុំ​ណែនាំ B** (សុវត្ថិភាព​ជាង, code តិច) — Worker ធ្វើ​ជា pure frontend + proxy, រាល់ mutations/reads ធ្វើ​តាម bot's authenticated bridge endpoint។

---

សូម​ឆ្លើយ៖
1. **A, B, ឬ C?** (បើ​អត់​ប្រាកដ, ជ្រើសរើស B)
2. តើ​អ្នក​បាន rotate token នៅ Cloudflare ហើយ​ឬ​នៅ?
3. តើ custom domain អ្វី​ដែល​អ្នក​ចង់​ភ្ជាប់? (ឬ​ប្រើ `*.workers.dev` default មុន)
