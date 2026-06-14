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

// Cache the admin client module load across requests (warm isolate) for lower latency
let _adminClientPromise: Promise<typeof import("@/integrations/supabase/client.server")> | null = null;
function getAdminClient() {
  if (!_adminClientPromise) {
    _adminClientPromise = import("@/integrations/supabase/client.server");
  }
  return _adminClientPromise;
}

type ReplyCacheEntry = { content: any; delete_after_seconds: number | null };
type ReplyCache = { expiresAt: number; config: number; replies: Map<string, ReplyCacheEntry> };
const REPLY_CACHE_TTL_MS = 1_500;
let replyCache: ReplyCache | null = null;
let replyCachePromise: Promise<ReplyCache> | null = null;

function clearReplyCache() {
  replyCache = null;
  replyCachePromise = null;
}

async function loadReplyCache(supabase: any): Promise<ReplyCache> {
  const now = Date.now();
  if (replyCache && replyCache.expiresAt > now) return replyCache;
  if (replyCachePromise) return replyCachePromise;

  replyCachePromise = Promise.all([
    supabase.from("replies").select("keyword, content, delete_after_seconds").order("created_at"),
    supabase.from("bot_config").select("delete_after_seconds").eq("id", 1).maybeSingle(),
  ]).then(([replyResult, configResult]: any[]) => {
    const replies = new Map<string, ReplyCacheEntry>();
    for (const row of replyResult.data ?? []) {
      replies.set(String(row.keyword).toLowerCase(), {
        content: row.content,
        delete_after_seconds: row.delete_after_seconds as number | null,
      });
    }
    replyCache = {
      expiresAt: Date.now() + REPLY_CACHE_TTL_MS,
      config: configResult.data?.delete_after_seconds ?? 0,
      replies,
    };
    replyCachePromise = null;
    return replyCache;
  });

  return replyCachePromise;
}

async function tgRequest(token: string, method: string, body: TgRequestBody) {
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
const MAIN_KEYBOARD = {
  keyboard: [["បន្ថែមពាក្យថ្មី"], ["បញ្ជីពាក្យ កែប្រែ&លុប"], ["⏱ កំណត់ Timer លុបសារ"]],
  resize_keyboard: true,
  persistent: true,
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

function buildListKeyboard(keys: string[]) {
  const rows: string[][] = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2));
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
type ReplyContent = {
  type: "copy";
  from_chat_id: number;
  message_id: number;
  forward: boolean;
};

function getReplyContent(msg: any): ReplyContent | null {
  const isForwarded = !!(msg.forward_from || msg.forward_origin || msg.forward_from_chat);
  const hasContent = !!(
    msg.text ||
    msg.photo ||
    msg.video ||
    msg.voice ||
    msg.audio ||
    msg.document ||
    msg.sticker
  );
  if (hasContent) {
    return {
      type: "copy",
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
      forward: isForwarded,
    };
  }
  return null;
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
) {
  let res: any;
  if (reply.type === "copy") {
    const method = reply.forward ? "forwardMessage" : "copyMessage";
    res = await tgRequest(token, method, {
      chat_id: chatId,
      from_chat_id: reply.from_chat_id,
      message_id: reply.message_id,
    });
  } else if (reply.type === "text") {
    res = await tgRequest(token, "sendMessage", { chat_id: chatId, text: reply.content });
  } else if (reply.type === "photo") {
    res = await tgRequest(token, "sendPhoto", {
      chat_id: chatId,
      photo: reply.content,
      caption: reply.caption,
    });
  } else if (reply.type === "video") {
    res = await tgRequest(token, "sendVideo", {
      chat_id: chatId,
      video: reply.content,
      caption: reply.caption,
    });
  } else if (reply.type === "voice") {
    res = await tgRequest(token, "sendVoice", { chat_id: chatId, voice: reply.content });
  } else if (reply.type === "audio") {
    res = await tgRequest(token, "sendAudio", {
      chat_id: chatId,
      audio: reply.content,
      caption: reply.caption,
    });
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
  if (rows.length > 0) {
    await supabase.from("pending_deletions").insert(rows);
  }
}

async function getEffectiveDeleteSeconds(supabase: any, match: any) {
  if (match.delete_after_seconds !== null && match.delete_after_seconds !== undefined) {
    return match.delete_after_seconds;
  }
  return loadConfig(supabase);
}

async function deleteAndSendMatch(
  token: string,
  supabase: any,
  chatId: number,
  messageId: number,
  match: any,
) {
  const effective = await getEffectiveDeleteSeconds(supabase, match);
  await Promise.all([
    tgRequest(token, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => {}),
    sendReplies(token, supabase, chatId, match.content, effective),
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
async function sendReplies(
  token: string,
  supabase: any,
  chatId: number,
  content: any,
  autoDeleteSeconds: number,
) {
  const list = Array.isArray(content) ? content : [content];
  const pendingRows = (await Promise.all(
    list.map((item) => sendReply(token, supabase, chatId, item, autoDeleteSeconds)),
  )).filter(Boolean);
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

async function loadConfig(supabase: any): Promise<number> {
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

async function getReplyByKeyword(supabase: any, keyword: string) {
  const cache = await loadReplyCache(supabase);
  return cache.replies.get(keyword) ?? null;
}

async function listKeywords(supabase: any): Promise<string[]> {
  const cache = await loadReplyCache(supabase);
  return [...cache.replies.keys()];
}

// ---------------------------------------------------------------------------
// Main message handler — mirrors handleMessage / handleUserMessage in bot.js
// ---------------------------------------------------------------------------
async function handleUserMessage(token: string, supabase: any, msg: any) {
  const chatId = msg.chat.id;
  const text: string | undefined = msg.text;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (isGroup) {
    if (text) {
      const match = await getReplyByKeyword(supabase, text.trim().toLowerCase());
      if (match) {
        await deleteAndSendMatch(token, supabase, chatId, msg.message_id, match);
      }
    }
    return;
  }

  const isStart = text === "/start" || text?.startsWith("/start@");

  if (isStart) {
    const keys = await listKeywords(supabase);
    if (keys.length === 0) {
      await tgRequest(token, "sendMessage", { chat_id: chatId, text: "សួស្តី! 👋" });
      return;
    }
    const rows: string[][] = [];
    for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2));
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `📋 បញ្ជីពាក្យឆ្លើយតប (${keys.length} ពាក្យ)\n\nសូមជ្រើសរើសពាក្យ៖`,
      reply_markup: { keyboard: rows, resize_keyboard: true },
    });
    return;
  }

  if (text) {
    const match = await getReplyByKeyword(supabase, text.trim().toLowerCase());
    if (match) {
      await deleteAndSendMatch(token, supabase, chatId, msg.message_id, match);
    }
  }
}

async function handleMessage(token: string, adminId: number, supabase: any, msg: any) {
  const chatId = msg.chat.id;
  const text: string | undefined = msg.text;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (isGroup) return handleUserMessage(token, supabase, msg);
  // Private chat: only admin allowed
  if (msg.from?.id !== adminId) return;

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
      reply_markup: buildListKeyboard(keys),
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
          reply_markup: buildListKeyboard(keys),
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


  // Fallback: admin tests a keyword when no state is active
  if (!s.state && text) {
    const match = await getReplyByKeyword(supabase, text.trim().toLowerCase());
    if (match) {
      // Parallelize delete + send for the fastest user-visible response
      await Promise.all([
        tgRequest(token, "deleteMessage", {
          chat_id: chatId,
          message_id: msg.message_id,
        }).catch(() => {}),
        sendReplies(token, supabase, chatId, match.content, 0),
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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

        // Always 200 OK quickly so Telegram doesn't retry
        try {
          const { supabaseAdmin } = await getAdminClient();
          const msg = update.message ?? update.edited_message;
          if (msg?.chat?.id) {
            await handleMessage(token, adminId, supabaseAdmin, msg);
          }
        } catch (err) {
          console.error("Telegram webhook error:", err);
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
