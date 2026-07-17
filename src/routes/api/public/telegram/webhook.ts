import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

function deriveWebhookToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

// ============================================================================
// Telegram Bot webhook — converted from long-polling bot.js
// Endpoint: POST /api/public/telegram/webhook
// Security: verifies X-Telegram-Bot-Api-Secret-Token header
// State is persisted in Lovable Cloud (no in-memory globals).
// ============================================================================

type TgRequestBody = Record<string, unknown>;

// Preload admin client module at isolate startup so first webhook call skips import cost.
// Also prewarm the reply cache (with retry + timeout) so the group fast-path can
// serve the first request inline even on a cold isolate.
let _adminClientPromise: Promise<typeof import("@/integrations/supabase/client.server")> | null =
  import("@/integrations/supabase/client.server")
    .then((mod) => {
      try {
        prewarmReplyCache(mod.supabaseAdmin).catch(() => {});
      } catch {}
      return mod;
    })
    .catch((e) => {
      _adminClientPromise = null;
      throw e;
    }) as any;
function getAdminClient() {
  if (!_adminClientPromise) {
    _adminClientPromise = import("@/integrations/supabase/client.server").then((mod) => {
      // Kick off a prewarm on lazy client init too.
      try { prewarmReplyCache(mod.supabaseAdmin).catch(() => {}); } catch {}
      return mod;
    });
  }
  return _adminClientPromise;
}


type ReplyCacheEntry = { content: any; delete_after_seconds: number | null };
type ReplyCache = {
  expiresAt: number;
  config: number;
  fastPathEnabled: boolean;
  replies: Map<string, ReplyCacheEntry>;
  rowsOrder: string[][];
  /** slash-command (without leading '/') → keyword */
  commands: Map<string, string>;
  /** keyword.toLowerCase() → slash-command (without leading '/') */
  keywordToCommand: Map<string, string>;
};
const REPLY_CACHE_TTL_MS = 8_000;
const GROUP_TRACK_TTL_MS = 10 * 60_000;
let replyCache: ReplyCache | null = null;
let replyCachePromise: Promise<ReplyCache> | null = null;
const groupTrackCache = new Map<number, number>();

// ---------------------------------------------------------------------------
// Metrics: latency + cache hit-rate + fast-path counters. In-memory per isolate.
// Exposed via GET /api/public/telegram/webhook?metrics=1&secret=<TELEGRAM_WEBHOOK_SECRET>
// ---------------------------------------------------------------------------
type Metrics = {
  startedAt: number;
  updates: number;
  deduped: number;
  cacheHit: number;      // reply cache warm at request time
  cacheMiss: number;     // reply cache cold at request time
  fastPathHit: number;   // served inline (single reply, group)
  fastPathMiss: number;  // eligible group text but no inline reply produced
  fastPathDisabled: number;
  errors: number;
  latencies: number[];   // ring buffer of last N request durations (ms)
  prewarmAttempts: number;
  prewarmSuccess: number;
  prewarmFailure: number;
  prewarmMs: number;     // duration of last successful prewarm
};
const METRICS_RING = 500;
const metrics: Metrics = {
  startedAt: Date.now(),
  updates: 0,
  deduped: 0,
  cacheHit: 0,
  cacheMiss: 0,
  fastPathHit: 0,
  fastPathMiss: 0,
  fastPathDisabled: 0,
  errors: 0,
  latencies: [],
  prewarmAttempts: 0,
  prewarmSuccess: 0,
  prewarmFailure: 0,
  prewarmMs: 0,
};
function recordLatency(ms: number) {
  if (metrics.latencies.length >= METRICS_RING) metrics.latencies.shift();
  metrics.latencies.push(ms);
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function snapshotMetrics() {
  const sorted = [...metrics.latencies].sort((a, b) => a - b);
  const total = metrics.cacheHit + metrics.cacheMiss;
  const fastTotal = metrics.fastPathHit + metrics.fastPathMiss + metrics.fastPathDisabled;
  return {
    uptime_ms: Date.now() - metrics.startedAt,
    updates: metrics.updates,
    deduped: metrics.deduped,
    errors: metrics.errors,
    cache: {
      hit: metrics.cacheHit,
      miss: metrics.cacheMiss,
      hit_rate: total ? +(metrics.cacheHit / total).toFixed(4) : 0,
      warm: replyCache !== null,
      ttl_ms: REPLY_CACHE_TTL_MS,
    },
    prewarm: {
      attempts: metrics.prewarmAttempts,
      success: metrics.prewarmSuccess,
      failure: metrics.prewarmFailure,
      last_ms: metrics.prewarmMs,
      inflight: prewarmInflight !== null,
    },
    fast_path: {
      hit: metrics.fastPathHit,
      miss: metrics.fastPathMiss,
      disabled: metrics.fastPathDisabled,
      hit_rate: fastTotal ? +(metrics.fastPathHit / fastTotal).toFixed(4) : 0,
    },
    latency_ms: {
      samples: sorted.length,
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] ?? 0,
      avg: sorted.length ? +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2) : 0,
    },
  };
}

// ---- update_id dedup (Telegram retries updates when the webhook is slow) ----
const seenUpdates = new Map<number, number>();
const UPDATE_DEDUP_TTL_MS = 5 * 60_000;
function isDuplicateUpdate(id: number | undefined): boolean {
  if (typeof id !== "number") return false;
  const now = Date.now();
  if (seenUpdates.size > 500) {
    for (const [k, t] of seenUpdates) if (now - t > UPDATE_DEDUP_TTL_MS) seenUpdates.delete(k);
  }
  if (seenUpdates.has(id)) return true;
  seenUpdates.set(id, now);
  return false;
}

// ---- Analytics: log every matched keyword hit (fire-and-forget) ----
export function logUsage(supabase: any, keyword: string, msg: any) {
  try {
    const row = {
      keyword,
      chat_id: msg?.chat?.id,
      chat_type: msg?.chat?.type ?? null,
      chat_title: msg?.chat?.title ?? null,
      user_id: msg?.from?.id ?? null,
      username: msg?.from?.username ?? null,
    };
    if (!row.chat_id) return;
    supabase.from("usage_logs").insert(row).then(() => {}, () => {});
  } catch {}
}

export function clearReplyCache() {
  replyCache = null;
  replyCachePromise = null;
}

// Telegram commands must match [a-z0-9_]{1,32}.
export function slugifyKeyword(keyword: string): string {
  let s = String(keyword).toLowerCase().normalize("NFKD");
  s = s.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) {
    let h = 0;
    for (const ch of keyword) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    s = `cmd_${h.toString(36)}`;
  }
  if (s.length > 32) s = s.slice(0, 32).replace(/_+$/, "");
  if (!s) s = "cmd";
  return s;
}

function buildCommandMaps(keywords: string[]) {
  const cmdToKw = new Map<string, string>();
  const kwToCmd = new Map<string, string>();
  // Number commands sequentially: /1, /2, /3, ... in keyword order.
  keywords.forEach((kw, i) => {
    const cmd = String(i + 1);
    cmdToKw.set(cmd, kw);
    kwToCmd.set(kw.toLowerCase(), cmd);
  });
  return { cmdToKw, kwToCmd };
}


// ---- Timeout + retry helpers for cache prewarm ---------------------------
const CACHE_FETCH_TIMEOUT_MS = 2500;
const PREWARM_MAX_ATTEMPTS = 4;
const PREWARM_BACKOFF_MS = [150, 400, 1000, 2000];

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function fetchReplyCache(supabase: any): Promise<ReplyCache> {
  if (replyCachePromise) return replyCachePromise;
  const query = Promise.all([
    supabase.from("replies").select("keyword, content, delete_after_seconds, position, row_index").order("row_index").order("position").order("created_at"),
    supabase.from("bot_config").select("delete_after_seconds, fast_path_enabled").eq("id", 1).maybeSingle(),
  ]);
  replyCachePromise = withTimeout(query, CACHE_FETCH_TIMEOUT_MS, "fetchReplyCache").then(([replyResult, configResult]: any[]) => {
    const replies = new Map<string, ReplyCacheEntry>();
    const rowsMap = new Map<number, string[]>();
    const orderedKeywords: string[] = [];
    for (const row of replyResult.data ?? []) {
      const kw = String(row.keyword);
      replies.set(kw.toLowerCase(), {
        content: row.content,
        delete_after_seconds: row.delete_after_seconds as number | null,
      });
      const ri = Number(row.row_index ?? 0);
      if (!rowsMap.has(ri)) rowsMap.set(ri, []);
      rowsMap.get(ri)!.push(kw);
      orderedKeywords.push(kw);
    }
    const rowsOrder = [...rowsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const { cmdToKw, kwToCmd } = buildCommandMaps(orderedKeywords);
    replyCache = {
      expiresAt: Date.now() + REPLY_CACHE_TTL_MS,
      config: configResult.data?.delete_after_seconds ?? 0,
      fastPathEnabled: configResult.data?.fast_path_enabled ?? true,
      replies,
      rowsOrder,
      commands: cmdToKw,
      keywordToCommand: kwToCmd,
    };
    replyCachePromise = null;
    return replyCache;
  }).catch((e) => {
    replyCachePromise = null;
    throw e;
  });
  return replyCachePromise;
}

// Fire-and-forget prewarm with retry + timeout. Safe to call repeatedly:
// a single prewarm run is deduped across concurrent callers.
let prewarmInflight: Promise<ReplyCache | null> | null = null;
export function prewarmReplyCache(supabase: any): Promise<ReplyCache | null> {
  if (replyCache && replyCache.expiresAt > Date.now()) return Promise.resolve(replyCache);
  if (prewarmInflight) return prewarmInflight;
  const start = Date.now();
  metrics.prewarmAttempts++;
  prewarmInflight = (async () => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < PREWARM_MAX_ATTEMPTS; attempt++) {
      try {
        const c = await fetchReplyCache(supabase);
        metrics.prewarmSuccess++;
        metrics.prewarmMs = Date.now() - start;
        return c;
      } catch (e) {
        lastErr = e;
        const backoff = PREWARM_BACKOFF_MS[attempt] ?? 2000;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    metrics.prewarmFailure++;
    console.warn("[webhook] prewarmReplyCache failed after retries:", lastErr);
    return null;
  })().finally(() => { prewarmInflight = null; });
  return prewarmInflight;
}


async function loadReplyCache(supabase: any): Promise<ReplyCache> {
  const now = Date.now();
  if (replyCache) {
    if (replyCache.expiresAt <= now && !replyCachePromise) {
      fetchReplyCache(supabase).catch(() => {});
    }
    return replyCache;
  }
  return fetchReplyCache(supabase);
}

// -------------------- setMyCommands sync --------------------
// Register commands under multiple scopes in parallel so Telegram clients
// (private chats + groups) refresh the slash-command menu immediately
// instead of waiting for the "default" scope cache to expire.
const COMMAND_SCOPES = [
  { type: "default" as const },
  { type: "all_private_chats" as const },
  { type: "all_group_chats" as const },
];
let lastCommandsSyncSig = "";
export async function syncBotCommands(token: string, supabase: any): Promise<void> {
  if (!token) return;
  const cache = await loadReplyCache(supabase);
  const commands = [...cache.commands.entries()].map(([command, keyword]) => ({
    command,
    description: keyword.slice(0, 256),
  }));
  const sig = JSON.stringify(commands);
  if (sig === lastCommandsSyncSig) return;
  lastCommandsSyncSig = sig;
  try {
    const results = await Promise.all(
      COMMAND_SCOPES.map((scope) => tgRequest(token, "setMyCommands", { commands, scope })),
    );
    const failed = results.find((r) => !r?.ok);
    if (failed) {
      console.error("setMyCommands failed", failed?.description);
      lastCommandsSyncSig = "";
    }
  } catch (err) {
    console.error("setMyCommands error", err);
    lastCommandsSyncSig = "";
  }
}

export function resetCommandsSyncSignature() {
  lastCommandsSyncSig = "";
}


export async function tgRequest(token: string, method: string, body: TgRequestBody) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: any; description?: string };
}

// ---------------------------------------------------------------------------
// Keyboards (preserved from bot.js)
// ---------------------------------------------------------------------------
export const MAIN_KEYBOARD = {
  keyboard: [
    ["បន្ថែមពាក្យថ្មី"],
    ["បញ្ជីពាក្យ កែប្រែ&លុប"],
    ["⏱ កំណត់ Timer លុបសារ", "⚡ Fast-Path"],
    ["📅 កំណត់ពេលផ្ញើទៅ Group", "📋 បញ្ជី Schedule"],
  ],
  resize_keyboard: true,
  is_persistent: true,
};


const SCHED_REPEAT_KEYBOARD = {
  keyboard: [["🔂 មួយដង", "🔁 រាល់ថ្ងៃ"], ["❌ បោះបង់"]],
  resize_keyboard: true,
};


const CANCEL_KEYBOARD = {
  keyboard: [["❌ បោះបង់"]],
  resize_keyboard: true,
};

const REPLY_COLLECT_KEYBOARD = {
  keyboard: [["✅ រួចរាល់"], ["❌ បោះបង់"]],
  resize_keyboard: true,
};

const ACTION_KEYBOARD = {
  keyboard: [["👁 មើល", "✏️ កែ", "🗑 លុប"], ["⏱ Timer"], ["❌ បោះបង់"]],
  resize_keyboard: true,
};


const TIMER_KEYBOARD = {
  keyboard: [
    ["បិទ (មិនលុប)"],
    ["10 វិ", "30 វិ", "1 នាទី"],
    ["2 នាទី", "5 នាទី", "10 នាទី"],
    ["❌ បោះបង់"],
  ],
  resize_keyboard: true,
};

const KEYWORD_TIMER_KEYBOARD = {
  keyboard: [
    
    ["បិទ (មិនលុប)"],
    ["10 វិ", "30 វិ", "1 នាទី"],
    ["2 នាទី", "5 នាទី", "10 នាទី"],
    ["❌ បោះបង់"],
  ],
  resize_keyboard: true,
};

function buildListKeyboard(keysOrRows: string[] | string[][]) {
  const rows: string[][] = [];
  if (Array.isArray(keysOrRows[0])) {
    for (const r of keysOrRows as string[][]) {
      const clean = r.filter(Boolean);
      if (clean.length > 0) rows.push(clean);
    }
  } else {
    for (const k of keysOrRows as string[]) rows.push([k]);
  }
  rows.push(["❌ បោះបង់"]);
  return { keyboard: rows, resize_keyboard: true };
}

function formatDelay(seconds: number): string {
  if (seconds === 0) return "បិទ (មិនលុប)";
  if (seconds < 60) return `${seconds} វិនាទី`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m} នាទី ${s} វិនាទី` : `${m} នាទី`;
}

function parseTimerLabel(label: string | undefined): number | null {
  if (!label) return null;
  if (label === "បិទ (មិនលុប)") return 0;
  if (label === "10 វិ") return 10;
  if (label === "30 វិ") return 30;
  if (label === "1 នាទី") return 60;
  if (label === "2 នាទី") return 120;
  if (label === "5 នាទី") return 300;
  if (label === "10 នាទី") return 600;
  return null;
}

// ---------------------------------------------------------------------------
// Reply content extraction (same shape as bot.js)
// ---------------------------------------------------------------------------
type ReplyContent =
  | { type: "copy"; from_chat_id: number; message_id: number; forward: boolean; media_group_id?: string }
  | { type: "text"; content: string }
  | { type: "photo"; content: string; caption?: string }
  | { type: "video"; content: string; caption?: string }
  | { type: "voice"; content: string }
  | { type: "audio"; content: string; caption?: string }
  | { type: "document"; content: string; caption?: string }
  | { type: "sticker"; content: string };

function getReplyContent(msg: any): ReplyContent | null {
  // Always use copy/forward so we preserve the exact original format:
  // - formatting entities (bold, italic, links, code, mentions)
  // - media + caption + caption entities
  // - stickers, voice, video notes, documents, polls, etc.
  // - "Forwarded from …" header when the admin forwarded the source message
  if (!msg?.chat?.id || !msg?.message_id) return null;
  const isForwarded = !!(msg.forward_from || msg.forward_origin || msg.forward_from_chat || msg.forward_sender_name);
  return {
    type: "copy",
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    forward: isForwarded,
    ...(msg.media_group_id ? { media_group_id: String(msg.media_group_id) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Send a stored reply and (optionally) schedule its auto-delete
// ---------------------------------------------------------------------------
async function sendReply(
  token: string,
  supabase: any,
  chatId: number,
  reply: any,
  autoDeleteSeconds: number,
  replyMarkup?: any,
) {
  let res: any;
  const extra = replyMarkup ? { reply_markup: replyMarkup } : {};
  if (reply.type === "copy") {
    const method = reply.forward ? "forwardMessage" : "copyMessage";
    res = await tgRequest(token, method, {
      chat_id: chatId,
      from_chat_id: reply.from_chat_id,
      message_id: reply.message_id,
      ...extra,
    });
  } else if (reply.type === "text") {
    res = await tgRequest(token, "sendMessage", { chat_id: chatId, text: reply.content, ...extra });
  } else if (reply.type === "photo") {
    res = await tgRequest(token, "sendPhoto", {
      chat_id: chatId,
      photo: reply.content,
      caption: reply.caption,
      ...extra,
    });
  } else if (reply.type === "video") {
    res = await tgRequest(token, "sendVideo", {
      chat_id: chatId,
      video: reply.content,
      caption: reply.caption,
      ...extra,
    });
  } else if (reply.type === "voice") {
    res = await tgRequest(token, "sendVoice", { chat_id: chatId, voice: reply.content, ...extra });
  } else if (reply.type === "audio") {
    res = await tgRequest(token, "sendAudio", {
      chat_id: chatId,
      audio: reply.content,
      caption: reply.caption,
      ...extra,
    });
  } else if (reply.type === "document") {
    res = await tgRequest(token, "sendDocument", {
      chat_id: chatId,
      document: reply.content,
      caption: reply.caption,
      ...extra,
    });
  } else if (reply.type === "sticker") {
    res = await tgRequest(token, "sendSticker", { chat_id: chatId, sticker: reply.content, ...extra });
  }

  if (!res?.ok) {
    console.error("Telegram send failed", { method: reply.type, chatId, description: res?.description });
  }

  return res?.ok && res.result?.message_id && autoDeleteSeconds > 0
    ? {
        chat_id: chatId,
        message_id: res.result.message_id,
        delete_at: new Date(Date.now() + autoDeleteSeconds * 1000).toISOString(),
      }
    : null;
}

async function insertPendingDeletions(supabase: any, rows: any[]) {
  if (rows.length === 0) return;
  // MUST await: on serverless (Cloudflare Workers), fire-and-forget promises
  // are terminated once the HTTP response is returned, so the insert
  // would silently never happen and auto-delete would never fire.
  const { error } = await supabase.from("pending_deletions").insert(rows);
  if (error) console.error("pending_deletions insert failed", error);
}

async function getEffectiveDeleteSeconds(supabase: any, match: any) {
  if (match.delete_after_seconds !== null && match.delete_after_seconds !== undefined) {
    return match.delete_after_seconds;
  }
  return loadConfig(supabase);
}

export function buildKeywordKeyboard(rows: string[][]) {
  const clean = rows.map((r) => r.filter(Boolean)).filter((r) => r.length > 0);
  if (clean.length === 0) return undefined;
  return { keyboard: clean, resize_keyboard: true, is_persistent: true };
}

async function listKeywordRows(supabase: any): Promise<string[][]> {
  const cache = await loadReplyCache(supabase);
  return cache.rowsOrder;
}


async function deleteAndSendMatch(
  token: string,
  supabase: any,
  chatId: number,
  messageId: number,
  match: any,
  replyMarkup?: any,
) {
  const effective = await getEffectiveDeleteSeconds(supabase, match);
  await Promise.all([
    tgRequest(token, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => {}),
    sendReplies(token, supabase, chatId, match.content, effective, replyMarkup),
  ]);
}

async function scheduleReplyDelete(supabase: any, chatId: number, messageId: number, autoDeleteSeconds: number) {
  if (autoDeleteSeconds > 0) {
    const deleteAt = new Date(Date.now() + autoDeleteSeconds * 1000).toISOString();
    await supabase.from("pending_deletions").insert({
      chat_id: chatId,
      message_id: messageId,
      delete_at: deleteAt,
    });
  }
}



// Send one or many replies (handles both legacy single-object and new array shapes)
// replyMarkup is attached only to the LAST item to avoid duplicate keyboards.
export async function sendReplies(
  token: string,
  supabase: any,
  chatId: number,
  content: any,
  autoDeleteSeconds: number,
  replyMarkup?: any,
) {
  const list = Array.isArray(content) ? content : [content];

  // Group items by media_group_id so an original Telegram album is re-sent as
  // a single album via copyMessages — preserving the album grouping, the
  // caption(s), and the original photo/video order.
  //
  // Grouping is robust to two real-world edge cases:
  //  1. Webhook updates for an album can arrive out of order, so items with
  //     the same media_group_id might not be consecutive in `list`.
  //  2. Inside each album we always send by ascending message_id, which is
  //     the order Telegram uses for the original album (and the only order
  //     that keeps the caption attached to the correct item).
  type Group =
    | { kind: "album"; items: any[]; anchor: number; lastOriginalIdx: number }
    | { kind: "single"; item: any; index: number };

  const groups: Group[] = [];
  const albumByKey = new Map<string, Group & { kind: "album" }>();

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    // Group by media_group_id regardless of forward flag — a forwarded album
    // is still an album; we just re-send it with forwardMessages instead of
    // copyMessages so the "Forwarded from" header is preserved.
    const isAlbumItem = item?.type === "copy" && item.media_group_id;

    if (isAlbumItem) {
      const key = `${item.from_chat_id}::${item.media_group_id}::${item.forward ? "fwd" : "cpy"}`;
      const existing = albumByKey.get(key);
      if (existing && existing.items.length < 10) {
        existing.items.push(item);
        existing.lastOriginalIdx = Math.max(existing.lastOriginalIdx, i);
        continue;
      }
      const g: Group & { kind: "album" } = {
        kind: "album",
        items: [item],
        anchor: i,
        lastOriginalIdx: i,
      };
      albumByKey.set(key, g);
      groups.push(g);
    } else {
      groups.push({ kind: "single", item, index: i });
    }
  }

  const lastIdx = list.length - 1;
  const pendingRows: any[] = [];

  for (const g of groups) {
    if (g.kind === "album" && g.items.length >= 2) {
      const first = g.items[0];
      // Ascending message_id = original album order → caption stays on the
      // right item and photos/videos appear in the correct sequence.
      const messageIds = g.items
        .map((it) => it.message_id)
        .sort((a, b) => a - b);
      const isForward = !!first.forward;
      const method = isForward ? "forwardMessages" : "copyMessages";
      const payload: any = {
        chat_id: chatId,
        from_chat_id: first.from_chat_id,
        message_ids: messageIds,
      };
      // copyMessages supports remove_caption; forwardMessages does not.
      if (!isForward) payload.remove_caption = false;
      const res = await tgRequest(token, method, payload);
      if (!res?.ok) {
        console.error(`${method} failed`, {
          chatId,
          description: res?.description,
        });
      } else if (autoDeleteSeconds > 0 && Array.isArray(res.result)) {
        const deleteAt = new Date(
          Date.now() + autoDeleteSeconds * 1000,
        ).toISOString();
        for (const r of res.result) {
          if (r?.message_id) {
            pendingRows.push({
              chat_id: chatId,
              message_id: r.message_id,
              delete_at: deleteAt,
            });
          }
        }
      }
      // copyMessages/forwardMessages do not support reply_markup. If this
      // album is the final reply, send a tiny follow-up carrying the keyboard
      // so group keyboards appear immediately after album responses too.
      if (replyMarkup && g.lastOriginalIdx === lastIdx) {
        await tgRequest(token, "sendMessage", {
          chat_id: chatId,
          text: "⌨️",
          reply_markup: replyMarkup,
        }).catch(() => {});
      }
    } else {
      const items = g.kind === "album" ? g.items : [g.item];
      // For a "degenerate" single-item album, treat the anchor position as
      // the item's index; otherwise use the recorded single index.
      const originalIdx = g.kind === "album" ? g.anchor : g.index;
      for (let k = 0; k < items.length; k++) {
        const isLast = originalIdx === lastIdx && k === items.length - 1;
        const row = await sendReply(
          token,
          supabase,
          chatId,
          items[k],
          autoDeleteSeconds,
          isLast ? replyMarkup : undefined,
        );
        if (row) pendingRows.push(row);
      }
    }
  }

  await insertPendingDeletions(supabase, pendingRows);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
async function loadState(supabase: any, chatId: number) {
  const { data } = await supabase
    .from("admin_state")
    .select("state, pending_keyword, selected_keyword, pending_replies")
    .eq("chat_id", chatId)
    .maybeSingle();
  return (
    data ?? {
      state: null,
      pending_keyword: null,
      selected_keyword: null,
      pending_replies: [],
    }
  );
}

async function saveState(
  supabase: any,
  chatId: number,
  state: string | null,
  pendingKeyword: string | null,
  selectedKeyword: string | null,
  pendingReplies: any[] = [],
) {
  await supabase
    .from("admin_state")
    .upsert(
      {
        chat_id: chatId,
        state,
        pending_keyword: pendingKeyword,
        selected_keyword: selectedKeyword,
        pending_replies: pendingReplies,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "chat_id" },
    );
}

export async function loadConfig(supabase: any): Promise<number> {
  const cache = await loadReplyCache(supabase);
  return cache.config;
}

async function loadConfigFresh(supabase: any): Promise<number> {
  const { data } = await supabase
    .from("bot_config")
    .select("delete_after_seconds")
    .eq("id", 1)
    .maybeSingle();
  return data?.delete_after_seconds ?? 0;
}

async function saveConfig(supabase: any, seconds: number) {
  await supabase
    .from("bot_config")
    .upsert({ id: 1, delete_after_seconds: seconds, updated_at: new Date().toISOString() });
  clearReplyCache();
}

async function loadFastPathEnabled(supabase: any): Promise<boolean> {
  const cache = await loadReplyCache(supabase);
  return cache.fastPathEnabled;
}

async function saveFastPathEnabled(supabase: any, enabled: boolean) {
  await supabase
    .from("bot_config")
    .upsert({ id: 1, fast_path_enabled: enabled, updated_at: new Date().toISOString() });
  clearReplyCache();
}

async function getReplyByKeyword(supabase: any, keyword: string) {
  const cache = await loadReplyCache(supabase);
  return cache.replies.get(keyword) ?? null;
}

async function listKeywords(supabase: any): Promise<string[]> {
  const cache = await loadReplyCache(supabase);
  return [...cache.replies.keys()];
}

// ---------------------------------------------------------------------------
// Slash-command parsing
// ---------------------------------------------------------------------------
// A slash command message from Telegram looks like:
//   "/qr" or "/qr@my_bot" or "/qr some args"
// We strip the leading '/', drop the "@botname" suffix, and lowercase.
export function parseSlashCommand(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const first = t.split(/\s+/, 1)[0].slice(1);
  const at = first.indexOf("@");
  const raw = at >= 0 ? first.slice(0, at) : first;
  const cmd = raw.toLowerCase();
  return cmd || null;
}

async function resolveCommandKeyword(
  supabase: any,
  cmd: string,
): Promise<{ keyword: string; entry: ReplyCacheEntry } | null> {
  const cache = await loadReplyCache(supabase);
  const kw = cache.commands.get(cmd);
  if (!kw) return null;
  const entry = cache.replies.get(kw.toLowerCase());
  if (!entry) return null;
  return { keyword: kw, entry };
}

// ---------------------------------------------------------------------------
// Main message handler — mirrors handleMessage / handleUserMessage in bot.js
// ---------------------------------------------------------------------------
export async function handleUserMessage(token: string, supabase: any, msg: any) {
  const chatId = msg.chat.id;
  const text: string | undefined = msg.text;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (isGroup) {
    // Track this group so admin can pick it for scheduled sends.
    const now = Date.now();
    const lastTrackedAt = groupTrackCache.get(chatId) ?? 0;
    if (now - lastTrackedAt > GROUP_TRACK_TTL_MS) {
      groupTrackCache.set(chatId, now);
      supabase
        .from("tg_groups")
        .upsert(
          {
            chat_id: chatId,
            title: msg.chat.title ?? null,
            is_member: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "chat_id" },
        )
        .then(() => {}, () => groupTrackCache.delete(chatId));
    }

    // Bot added to group → make sure the command menu is up to date.
    const botAdded = Array.isArray(msg.new_chat_members) &&
      msg.new_chat_members.some((m: any) => m?.is_bot);
    if (botAdded) {
      syncBotCommands(token, supabase).catch(() => {});
    }

    const cmd = parseSlashCommand(text);
    if (cmd) {
      if (cmd === "start" || cmd.startsWith("start")) {
        // Ensure the slash-command menu is populated for this bot.
        syncBotCommands(token, supabase).catch(() => {});
        return;
      }
      const hit = await resolveCommandKeyword(supabase, cmd);
      if (hit) {
        logUsage(supabase, hit.keyword, msg);
        await deleteAndSendMatch(token, supabase, chatId, msg.message_id, hit.entry);
      }
    }
    return;
  }

  // ---------- Private chat (non-admin user) ----------
  const cmd = parseSlashCommand(text);
  if (cmd === "start") {
    await syncBotCommands(token, supabase).catch(() => {});
    const keys = await listKeywords(supabase);
    if (keys.length === 0) {
      await tgRequest(token, "sendMessage", { chat_id: chatId, text: "សួស្តី! 👋" });
      return;
    }
    const cache = await loadReplyCache(supabase);
    const lines = [...cache.commands.entries()].map(
      ([c, kw]) => `/${c} — ${kw}`,
    );
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `📋 បញ្ជីពាក្យបញ្ជា (${lines.length})\n\n${lines.join("\n")}`,
    });
    return;
  }

  if (cmd) {
    const hit = await resolveCommandKeyword(supabase, cmd);
    if (hit) {
      await deleteAndSendMatch(token, supabase, chatId, msg.message_id, hit.entry);
    }
  }
}


export async function handleMessage(token: string, adminId: number, supabase: any, msg: any) {
  const chatId = msg.chat.id;
  const text: string | undefined = msg.text;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (isGroup) return handleUserMessage(token, supabase, msg);
  // Private chat: only admins (env + admin_settings table) allowed
  const { isAdminUserId } = await import("@/lib/admin-config.server");
  if (!(await isAdminUserId(msg.from?.id))) return;

  // -------- ADMIN --------
  const s = await loadState(supabase, chatId);

  if (text === "/start" || text === "❌ បោះបង់") {
    await saveState(supabase, chatId, null, null, null);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "👨‍💻 ផ្ទាំងគ្រប់គ្រង Auto-Reply Bot\n\nសួស្ដីម្ចាស់គណនី សូមជ្រើសរើសមុខងារខាងក្រោម៖",
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }

  if (text === "⚡ Fast-Path") {
    const enabled = await loadFastPathEnabled(supabase);
    const next = !enabled;
    await saveFastPathEnabled(supabase, next);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: next
        ? "⚡ Fast-Path: ✅ បើក\n\nBot នឹងឆ្លើយលឿនបំផុត (round-trip តែមួយ)។\nចំណាំ: សារ bot នឹងមិនត្រូវលុបស្វ័យប្រវត្តិទេ ទោះបី Timer បើកក៏ដោយ។"
        : "⚡ Fast-Path: ⛔ បិទ\n\nBot នឹងឆ្លើយធម្មតា (យឺតជាងបន្តិច) ប៉ុន្តែ auto-delete សារ bot នឹងដំណើរការពេញលេញ។",
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }

  if (text === "⏱ កំណត់ Timer លុបសារ") {
    await saveState(supabase, chatId, "setting_timer", null, null);
    const cfg = await loadConfig(supabase);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `⏱ កំណត់ Timer លុបសារលទ្ធផលដោយស្វ័យប្រវត្តិ\n\n⚙️ ស្ថានភាពបច្ចុប្បន្ន: ${formatDelay(cfg)}\n\nសូមជ្រើសរើសរយៈពេល ឬ វាយលេខវិនាទី (ឧ: 45):`,
      reply_markup: TIMER_KEYBOARD,
    });
    return;
  }

  if (s.state === "setting_timer") {
    const preset = parseTimerLabel(text);
    let seconds: number | null = null;
    if (preset !== null) seconds = preset;
    else if (text && /^\d+$/.test(text.trim())) seconds = parseInt(text.trim(), 10);

    if (seconds !== null) {
      await saveConfig(supabase, seconds);
      await saveState(supabase, chatId, null, null, null);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text:
          seconds === 0
            ? "✅ បានបិទ Timer — សារលទ្ធផលនឹងមិនត្រូវបានលុបទេ។"
            : `✅ បានកំណត់ Timer — សារលទ្ធផលនឹងត្រូវបានលុបបន្ទាប់ពី ${formatDelay(seconds)}។`,
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }

    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ សូមជ្រើសរើសពីប៊ូតុង ឬ វាយចំនួនវិនាទីជាលេខ (ឧ: 45)។",
      reply_markup: TIMER_KEYBOARD,
    });
    return;
  }

  if (s.state === "setting_keyword_timer" && s.selected_keyword) {
    const kw = s.selected_keyword;
    let newVal: number | undefined = undefined; // undefined = invalid
    const preset = parseTimerLabel(text);
    if (preset !== null) newVal = preset;
    else if (text && /^\d+$/.test(text.trim())) newVal = parseInt(text.trim(), 10);

    if (newVal !== undefined) {
      await supabase
        .from("replies")
        .update({ delete_after_seconds: newVal, updated_at: new Date().toISOString() })
        .eq("keyword", kw);
      clearReplyCache();
      await saveState(supabase, chatId, "keyword_action", null, kw);
      const label = newVal === 0 ? "បិទ (មិនលុប)" : `លុបក្នុង ${formatDelay(newVal)}`;
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `✅ បានកំណត់ Timer សម្រាប់ [${kw}]\n⏱ ${label}`,
        reply_markup: ACTION_KEYBOARD,
      });
      return;
    }

    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ សូមជ្រើសរើសពីប៊ូតុង ឬ វាយចំនួនវិនាទីជាលេខ (ឧ: 45)។",
      reply_markup: KEYWORD_TIMER_KEYBOARD,
    });
    return;
  }

  // ===== Schedule send to group =====
  if (text === "📅 កំណត់ពេលផ្ញើទៅ Group") {
    const keys = await listKeywords(supabase);
    if (keys.length === 0) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "📭 មិនទាន់មានពាក្យឆ្លើយតបណាមួយទេ។ សូមបន្ថែមពាក្យជាមុនសិន។",
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }
    await saveState(supabase, chatId, "sched_kw", null, null, []);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "📅 កំណត់ពេលផ្ញើទៅ Group\n\nជំហានទី១: សូមជ្រើសរើស ពាក្យគន្លឹះ ដែលត្រូវផ្ញើ៖",
      reply_markup: buildListKeyboard(keys),
    });
    return;
  }

  if (s.state === "sched_kw" && text) {
    const kw = text.trim().toLowerCase();
    const existing = await getReplyByKeyword(supabase, kw);
    if (!existing) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ ពាក្យនេះមិនមានទេ។ សូមជ្រើសរើសពីប៊ូតុង៖",
      });
      return;
    }
    const { data: groups } = await supabase
      .from("tg_groups")
      .select("chat_id, title")
      .eq("is_member", true)
      .order("updated_at", { ascending: false });
    if (!groups || groups.length === 0) {
      await saveState(supabase, chatId, null, null, null, []);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "📭 មិនទាន់មាន Group ណាមួយដែល bot នៅក្នុងទេ។\n\n👉 សូមបន្ថែម bot ទៅក្នុង group ហើយផ្ញើសារណាមួយក្នុង group មុនសិន ដើម្បីឲ្យ bot ស្គាល់ group នោះ។",
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }
    const titles = groups.map((g: any) => g.title || `Group ${g.chat_id}`);
    await saveState(supabase, chatId, "sched_group", kw, null, groups as any);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `✅ ពាក្យ: [${kw}]\n\nជំហានទី២: សូមជ្រើសរើស Group៖`,
      reply_markup: buildListKeyboard(titles),
    });
    return;
  }

  if (s.state === "sched_group" && text) {
    const kw = s.pending_keyword!;
    const groups: any[] = Array.isArray(s.pending_replies) ? s.pending_replies : [];
    const picked = groups.find(
      (g) => (g.title || `Group ${g.chat_id}`) === text.trim(),
    );
    if (!picked) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ សូមជ្រើសរើស Group ពីប៊ូតុង៖",
      });
      return;
    }
    await saveState(supabase, chatId, "sched_repeat", kw, String(picked.chat_id), [
      { group_title: picked.title ?? null },
    ] as any);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `✅ Group: ${picked.title ?? picked.chat_id}\n\nជំហានទី៣: តើផ្ញើបែបណា?`,
      reply_markup: SCHED_REPEAT_KEYBOARD,
    });
    return;
  }

  if (s.state === "sched_repeat" && text) {
    const kw = s.pending_keyword!;
    const gid = s.selected_keyword!;
    if (text === "🔂 មួយដង") {
      await saveState(supabase, chatId, "sched_time_once", kw, gid, s.pending_replies as any);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "📆 សូមវាយម៉ោងផ្ញើ (ម៉ោងភ្នំពេញ)៖\n\nទម្រង់: YYYY-MM-DD HH:MM\nឧ. 2026-06-20 14:30",
        reply_markup: CANCEL_KEYBOARD,
      });
      return;
    }
    if (text === "🔁 រាល់ថ្ងៃ") {
      await saveState(supabase, chatId, "sched_time_daily", kw, gid, s.pending_replies as any);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "🕒 សូមវាយម៉ោងផ្ញើរាល់ថ្ងៃ (ម៉ោងភ្នំពេញ)៖\n\nទម្រង់: HH:MM\nឧ. 09:00",
        reply_markup: CANCEL_KEYBOARD,
      });
      return;
    }
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ សូមជ្រើសរើស 🔂 មួយដង ឬ 🔁 រាល់ថ្ងៃ៖",
      reply_markup: SCHED_REPEAT_KEYBOARD,
    });
    return;
  }

  if (s.state === "sched_time_once" && text) {
    const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (!m) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ ទម្រង់មិនត្រឹមត្រូវ។ សូមវាយ YYYY-MM-DD HH:MM (ឧ. 2026-06-20 14:30)៖",
        reply_markup: CANCEL_KEYBOARD,
      });
      return;
    }
    const [, y, mo, d, hh, mm] = m;
    // Phnom Penh is UTC+7 (no DST). Convert to UTC by subtracting 7h.
    const utc = new Date(Date.UTC(+y, +mo - 1, +d, +hh - 7, +mm));
    if (isNaN(utc.getTime())) {
      await tgRequest(token, "sendMessage", { chat_id: chatId, text: "⚠️ កាលបរិច្ឆេទមិនត្រឹមត្រូវ។" });
      return;
    }
    const meta: any[] = Array.isArray(s.pending_replies) ? s.pending_replies : [];
    const gtitle = meta[0]?.group_title ?? null;
    await supabase.from("scheduled_messages").insert({
      keyword: s.pending_keyword,
      group_chat_id: Number(s.selected_keyword),
      group_title: gtitle,
      scheduled_at: utc.toISOString(),
      repeat_daily: false,
      enabled: true,
    });
    await saveState(supabase, chatId, null, null, null, []);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `✅ បានកំណត់!\n📅 ${y}-${mo}-${d} ${hh}:${mm} (ភ្នំពេញ)\n📨 ពាក្យ [${s.pending_keyword}] → ${gtitle ?? s.selected_keyword}\n🔂 មួយដង`,
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }

  if (s.state === "sched_time_daily" && text) {
    const m = text.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!m) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ ទម្រង់មិនត្រឹមត្រូវ។ សូមវាយ HH:MM (ឧ. 09:00)៖",
        reply_markup: CANCEL_KEYBOARD,
      });
      return;
    }
    const meta: any[] = Array.isArray(s.pending_replies) ? s.pending_replies : [];
    const gtitle = meta[0]?.group_title ?? null;
    await supabase.from("scheduled_messages").insert({
      keyword: s.pending_keyword,
      group_chat_id: Number(s.selected_keyword),
      group_title: gtitle,
      daily_time: `${m[1]}:${m[2]}`,
      repeat_daily: true,
      enabled: true,
    });
    await saveState(supabase, chatId, null, null, null, []);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `✅ បានកំណត់!\n🕒 រាល់ថ្ងៃ ម៉ោង ${m[1]}:${m[2]} (ភ្នំពេញ)\n📨 ពាក្យ [${s.pending_keyword}] → ${gtitle ?? s.selected_keyword}`,
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }

  if (text === "📋 បញ្ជី Schedule") {
    const { data: rows } = await supabase
      .from("scheduled_messages")
      .select("id, keyword, group_title, group_chat_id, scheduled_at, daily_time, repeat_daily, enabled")
      .eq("enabled", true)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!rows || rows.length === 0) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "📭 មិនទាន់មាន Schedule ណាមួយទេ។",
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }
    const lines = rows.map((r: any, i: number) => {
      const when = r.repeat_daily
        ? `🔁 រាល់ថ្ងៃ ${r.daily_time} (PP)`
        : `🔂 ${new Date(new Date(r.scheduled_at).getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace("T", " ")} (PP)`;
      return `${i + 1}. [${r.keyword}] → ${r.group_title ?? r.group_chat_id}\n   ${when}\n   🗑 លុប: /del_${r.id}`;
    });
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `📋 បញ្ជី Schedule (${rows.length})\n\n${lines.join("\n\n")}`,
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }

  if (text && /^\/del_\d+$/.test(text.trim())) {
    const id = Number(text.trim().slice(5));
    await supabase.from("scheduled_messages").delete().eq("id", id);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `🗑 បានលុប Schedule #${id}`,
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }


  if (text === "បន្ថែមពាក្យថ្មី") {
    await saveState(supabase, chatId, "waiting_keyword", null, null);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "🛠 ប្រព័ន្ធបន្ថែមពាក្យឆ្លើយតប\n\nជំហានទី១: សូមវាយ ពាក្យគន្លឹះ\n\n💡 ឧទាហរណ៍៖ សុំ qr, qr aba, qr code",
      reply_markup: CANCEL_KEYBOARD,
    });
    return;
  }

  if (text === "បញ្ជីពាក្យ កែប្រែ&លុប") {
    const keys = await listKeywords(supabase);
    if (keys.length === 0) {
      await saveState(supabase, chatId, null, null, null);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "📭 មិនទាន់មានពាក្យណាមួយទេ។ សូមបន្ថែមពាក្យថ្មីជាមុនសិន។",
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }
    await saveState(supabase, chatId, "browsing_list", null, null);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `📋 បញ្ជីពាក្យឆ្លើយតប (${keys.length} ពាក្យ)\n\nសូមជ្រើសរើសពាក្យ៖`,
      reply_markup: buildListKeyboard(await listKeywordRows(supabase)),
    });
    return;
  }

  // Browsing list — user tapped a keyword
  if (s.state === "browsing_list" && text) {
    const kw = text.trim().toLowerCase();
    const existing = await getReplyByKeyword(supabase, kw);
    if (!existing) return;
    await saveState(supabase, chatId, "keyword_action", null, kw);
    const cfg = await loadConfig(supabase);
    const eff = existing.delete_after_seconds ?? cfg;
    const timerLabel =
      eff === 0 ? "បិទ (មិនលុប)" : `លុបក្នុង ${formatDelay(eff)}`;
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `📝 ពាក្យ: [${kw}]\n⏱ Timer បច្ចុប្បន្ន: ${timerLabel}\n\nសូមជ្រើសរើសសកម្មភាព៖`,
      reply_markup: ACTION_KEYBOARD,
    });
    return;
  }

  // Action on selected keyword
  if (s.state === "keyword_action" && s.selected_keyword) {
    const kw = s.selected_keyword;
    if (text === "👁 មើល") {
      const existing = await getReplyByKeyword(supabase, kw);
      const cfg = await loadConfig(supabase);
      const eff = existing?.delete_after_seconds ?? cfg;
      const label = eff === 0 ? "បិទ (មិនលុប)" : `លុបក្នុង ${formatDelay(eff)}`;
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `👁 ការឆ្លើយតបសម្រាប់ [${kw}]\n⏱ ${label}`,
      });
      if (existing) await sendReplies(token, supabase, chatId, existing.content, 0);
      return;
    }

    if (text === "⏱ Timer") {
      const existing = await getReplyByKeyword(supabase, kw);
      const cfg = await loadConfig(supabase);
      const eff = existing?.delete_after_seconds ?? cfg;
      const current = eff === 0 ? "បិទ (មិនលុប)" : `លុបក្នុង ${formatDelay(eff)}`;
      await saveState(supabase, chatId, "setting_keyword_timer", null, kw);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `⏱ កំណត់ Timer លុបសារសម្រាប់ពាក្យ [${kw}]\n\n⚙️ បច្ចុប្បន្ន: ${current}\n\nសូមជ្រើសរើស ឬ វាយចំនួនវិនាទី (ឧ: 45):`,
        reply_markup: KEYWORD_TIMER_KEYBOARD,
      });
      return;
    }

    // Position/reorder is managed exclusively via the Mini App now.





    if (text === "✏️ កែ") {
      await saveState(supabase, chatId, "waiting_reply", kw, null, []);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `✏️ កែប្រែពាក្យ [${kw}]\n\nសូមផ្ញើ អក្សរ, រូបភាព, វីដេអូ ឬ សំឡេង ថ្មី (អាចផ្ញើច្រើនបាន)។\nបន្ទាប់មកចុច ✅ រួចរាល់ ដើម្បីរក្សាទុក៖`,
        reply_markup: REPLY_COLLECT_KEYBOARD,
      });
      return;
    }

    if (text === "🗑 លុប") {
      await supabase.from("replies").delete().eq("keyword", kw);
      clearReplyCache();
      resetCommandsSyncSignature();
      syncBotCommands(token, supabase).catch(() => {});
      const keys = await listKeywords(supabase);
      if (keys.length === 0) {
        await saveState(supabase, chatId, null, null, null);
        await tgRequest(token, "sendMessage", {
          chat_id: chatId,
          text: `🗑 បានលុបពាក្យ [${kw}] រួចរាល់។\n\n📭 មិនទាន់មានពាក្យណាមួយទេ។`,
          reply_markup: MAIN_KEYBOARD,
        });
      } else {
        await saveState(supabase, chatId, "browsing_list", null, null);
        await tgRequest(token, "sendMessage", {
          chat_id: chatId,
          text: `🗑 បានលុបពាក្យ [${kw}] រួចរាល់។\n\n📋 បញ្ជីពាក្យ (${keys.length} ពាក្យ)\n\nសូមជ្រើសរើសពាក្យ៖`,
          reply_markup: buildListKeyboard(await listKeywordRows(supabase)),
        });
      }
      return;
    }
  }

  // Add keyword flow
  if (s.state === "waiting_keyword" && text) {
    const kw = text.trim().toLowerCase();
    await saveState(supabase, chatId, "waiting_reply", kw, null, []);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `✅ ទទួលពាក្យ: ${text.trim()}\n\nជំហានទី២: សូមផ្ញើ អក្សរ, រូបភាព, វីដេអូ ឬ សំឡេង (អាចផ្ញើច្រើនបាន)។\nបន្ទាប់មកចុច ✅ រួចរាល់ ដើម្បីរក្សាទុក៖`,
      reply_markup: REPLY_COLLECT_KEYBOARD,
    });
    return;
  }

  if (s.state === "waiting_reply") {
    const collected: any[] = Array.isArray(s.pending_replies) ? s.pending_replies : [];
    const kw = s.pending_keyword;
    if (!kw) return;

    // User finished collecting
    if (text === "✅ រួចរាល់") {
      if (collected.length === 0) {
        await tgRequest(token, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ មិនទាន់មានសារណាមួយទេ។ សូមផ្ញើយ៉ាងហោចណាស់មួយសារ មុនចុច ✅ រួចរាល់។",
          reply_markup: REPLY_COLLECT_KEYBOARD,
        });
        return;
      }
      const finalContent = collected.length === 1 ? collected[0] : collected;
      await supabase
        .from("replies")
        .upsert(
          { keyword: kw, content: finalContent, updated_at: new Date().toISOString() },
          { onConflict: "keyword" },
        );
      clearReplyCache();
      resetCommandsSyncSignature();
      syncBotCommands(token, supabase).catch(() => {});


      await saveState(supabase, chatId, null, null, null, []);
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `🎉 រៀបចំរួចរាល់!\nពាក្យ [${kw}] នឹងបង្ហាញលទ្ធផល (${collected.length} សារ) ៖`,
        reply_markup: MAIN_KEYBOARD,
      });
      await sendReplies(token, supabase, chatId, finalContent, 0);
      return;
    }

    const replyContent = getReplyContent(msg);
    if (!replyContent) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ មិនទទួលស្គាល់ប្រភេទនេះទេ។ សូមផ្ញើ អក្សរ, រូបភាព, វីដេអូ ឬ សំឡេង។",
        reply_markup: REPLY_COLLECT_KEYBOARD,
      });
      return;
    }

    collected.push(replyContent);
    await saveState(supabase, chatId, "waiting_reply", kw, null, collected);
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `📥 បានទទួលសារទី ${collected.length}។\nផ្ញើបន្ថែម ឬ ចុច ✅ រួចរាល់ ដើម្បីរក្សាទុក។`,
      reply_markup: REPLY_COLLECT_KEYBOARD,
    });
    return;
  }


  // Fallback: admin tests a keyword via slash command (/cmd) when no state is active
  if (!s.state && text) {
    const cmd = parseSlashCommand(text);
    if (cmd) {
      const hit = await resolveCommandKeyword(supabase, cmd);
      if (hit) {
        logUsage(supabase, hit.keyword, msg);
        await Promise.all([
          tgRequest(token, "deleteMessage", {
            chat_id: chatId,
            message_id: msg.message_id,
          }).catch(() => {}),
          sendReplies(token, supabase, chatId, hit.entry.content, 0, MAIN_KEYBOARD),
        ]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
        const provided = url.searchParams.get("secret") ?? request.headers.get("x-metrics-secret") ?? "";
        if (!expectedSecret || !safeEqual(provided, expectedSecret)) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify(snapshotMetrics(), null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      POST: async ({ request }) => {
        const __start = Date.now();
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const adminId = Number(process.env.ADMIN_CHAT_ID);
        const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

        if (!token || !adminId || !expectedSecret) {
          return new Response("Bot not configured", { status: 500 });
        }

        // Verify Telegram secret token
        const expectedToken = deriveWebhookToken(expectedSecret);
        const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (!safeEqual(provided, expectedToken)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let update: any;
        try {
          update = await request.json();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        metrics.updates++;

        // Idempotency: Telegram retries updates when the webhook is slow — dedupe.
        if (isDuplicateUpdate(update?.update_id)) {
          metrics.deduped++;
          recordLatency(Date.now() - __start);
          return new Response(JSON.stringify({ ok: true, deduped: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // ---- Inbox: persist every update for admin review (fire-and-forget) ----
        (async () => {
          try {
            const { supabaseAdmin } = await getAdminClient();
            const kinds = [
              "message", "edited_message", "channel_post", "edited_channel_post",
              "callback_query", "inline_query", "chosen_inline_result",
              "my_chat_member", "chat_member", "chat_join_request",
              "poll", "poll_answer", "shipping_query", "pre_checkout_query",
            ];
            const kind = kinds.find((k) => update[k]) ?? "unknown";
            const src = update[kind] ?? {};
            const chat = src.chat ?? src.message?.chat ?? null;
            const from = src.from ?? null;
            let preview: string | null =
              src.text ?? src.caption ?? src.data ?? src.query ?? null;
            if (typeof preview === "string" && preview.length > 200) preview = preview.slice(0, 200);
            await supabaseAdmin.from("telegram_updates").insert({
              update_id: typeof update.update_id === "number" ? update.update_id : null,
              update_type: kind,
              chat_id: chat?.id ?? null,
              chat_title: chat?.title ?? null,
              chat_type: chat?.type ?? null,
              user_id: from?.id ?? null,
              username: from?.username ?? null,
              text_preview: preview,
              payload: update,
            });
          } catch {}
        })();

        // Auto-sync slash-commands on every incoming update (deduped by signature — cheap no-op when unchanged).
        (async () => {
          try {
            const { supabaseAdmin } = await getAdminClient();
            await syncBotCommands(token, supabaseAdmin);
          } catch {}
        })();

        // ---- Handle my_chat_member: update tg_groups.is_member on add/remove ----
        if (update.my_chat_member) {
          try {
            const cm = update.my_chat_member;
            const chatId = cm.chat?.id;
            const chatType = cm.chat?.type;
            const status = cm.new_chat_member?.status;
            const isMember = status === "member" || status === "administrator" || status === "creator";
            if (chatId && (chatType === "group" || chatType === "supergroup")) {
              const { supabaseAdmin } = await getAdminClient();
              await supabaseAdmin
                .from("tg_groups")
                .upsert(
                  {
                    chat_id: chatId,
                    title: cm.chat?.title ?? null,
                    is_member: !!isMember,
                    updated_at: new Date().toISOString(),
                  },
                  { onConflict: "chat_id" },
                );
              if (!isMember) groupTrackCache.delete(chatId);
            }
          } catch (err) {
            console.error("my_chat_member handler error:", err);
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        const msg = update.message ?? update.edited_message;

        // ---- FAST PATH: group keyword match with single reply ----
        // Respond to Telegram with the send method inline in this HTTP
        // response body — saves one full API round-trip per reply.
        try {
          if (msg?.chat?.id && (msg.chat.type === "group" || msg.chat.type === "supergroup") && msg.text) {
            const { supabaseAdmin } = await getAdminClient();
            let cache = replyCache; // sync peek; only take fast path when cache is hot
            if (cache) metrics.cacheHit++; else metrics.cacheMiss++;
            if (!cache) {
              // Cold isolate — warm cache in background so next call fast-paths.
              fetchReplyCache(supabaseAdmin).catch(() => {});
            }
            if (cache && !cache.fastPathEnabled) metrics.fastPathDisabled++;
            if (cache && cache.fastPathEnabled) {
              const parsedCmd = parseSlashCommand(msg.text);
              const kw = parsedCmd ? cache.commands.get(parsedCmd) : undefined;
              const match = kw ? cache.replies.get(kw.toLowerCase()) : undefined;
              if (match && !Array.isArray(match.content)) {
                const chatId = msg.chat.id;
                logUsage(supabaseAdmin, kw!, msg);

                // Fire-and-forget: delete user message + group tracking
                fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: chatId, message_id: msg.message_id }),
                }).catch(() => {});

                const now = Date.now();
                if (now - (groupTrackCache.get(chatId) ?? 0) > GROUP_TRACK_TTL_MS) {
                  groupTrackCache.set(chatId, now);
                  supabaseAdmin
                    .from("tg_groups")
                    .upsert(
                      { chat_id: chatId, title: msg.chat.title ?? null, is_member: true, updated_at: new Date().toISOString() },
                      { onConflict: "chat_id" },
                    )
                    .then(() => {}, () => groupTrackCache.delete(chatId));
                }

                const r = match.content;
                const inline: any = { chat_id: chatId };
                if (r.type === "text") { inline.method = "sendMessage"; inline.text = r.content; }
                else if (r.type === "photo") { inline.method = "sendPhoto"; inline.photo = r.content; if (r.caption) inline.caption = r.caption; }
                else if (r.type === "video") { inline.method = "sendVideo"; inline.video = r.content; if (r.caption) inline.caption = r.caption; }
                else if (r.type === "voice") { inline.method = "sendVoice"; inline.voice = r.content; }
                else if (r.type === "audio") { inline.method = "sendAudio"; inline.audio = r.content; if (r.caption) inline.caption = r.caption; }
                else if (r.type === "document") { inline.method = "sendDocument"; inline.document = r.content; if (r.caption) inline.caption = r.caption; }
                else if (r.type === "sticker") { inline.method = "sendSticker"; inline.sticker = r.content; }
                else if (r.type === "copy") {
                  inline.method = r.forward ? "forwardMessage" : "copyMessage";
                  inline.from_chat_id = r.from_chat_id;
                  inline.message_id = r.message_id;
                }

                if (inline.method) {
                  // Inline webhook response: Telegram sends the reply in the
                  // same HTTP round-trip. Auto-delete of the bot's own reply
                  // is skipped in fast path (no message_id returned inline).
                  metrics.fastPathHit++;
                  recordLatency(Date.now() - __start);
                  return new Response(JSON.stringify(inline), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  });
                }
                metrics.fastPathMiss++;
              } else {
                metrics.fastPathMiss++;
              }
            }
          }

        } catch (err) {
          metrics.errors++;
          console.error("Telegram fast-path error:", err);
        }

        // ---- Normal path ----
        try {
          const { supabaseAdmin } = await getAdminClient();
          if (msg?.chat?.id) {
            await handleMessage(token, adminId, supabaseAdmin, msg);
          }
        } catch (err) {
          metrics.errors++;
          console.error("Telegram webhook error:", err);
        }

        const __elapsed = Date.now() - __start;
        recordLatency(__elapsed);
        if (__elapsed > 1000) console.warn(`[webhook] slow update ${update?.update_id} took ${__elapsed}ms`);

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});

