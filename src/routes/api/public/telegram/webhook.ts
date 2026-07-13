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

// Preload admin client module at isolate startup so first webhook call skips import cost
let _adminClientPromise: Promise<typeof import("@/integrations/supabase/client.server")> | null =
  import("@/integrations/supabase/client.server").catch((e) => {
    _adminClientPromise = null;
    throw e;
  }) as any;
function getAdminClient() {
  if (!_adminClientPromise) {
    _adminClientPromise = import("@/integrations/supabase/client.server");
  }
  return _adminClientPromise;
}

type ReplyCacheEntry = { content: any; delete_after_seconds: number | null };
type ReplyCache = { expiresAt: number; config: number; replies: Map<string, ReplyCacheEntry> };
const REPLY_CACHE_TTL_MS = 5 * 60_000; // 5 min hot cache
const GROUP_TRACK_TTL_MS = 10 * 60_000;
let replyCache: ReplyCache | null = null;
let replyCachePromise: Promise<ReplyCache> | null = null;
const groupTrackCache = new Map<number, number>();

export function clearReplyCache() {
  replyCache = null;
  replyCachePromise = null;
}

function fetchReplyCache(supabase: any): Promise<ReplyCache> {
  if (replyCachePromise) return replyCachePromise;
  replyCachePromise = Promise.all([
    supabase.from("replies").select("keyword, content, delete_after_seconds, position").order("position").order("created_at"),
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
  }).catch((e) => {
    replyCachePromise = null;
    throw e;
  });
  return replyCachePromise;
}

async function loadReplyCache(supabase: any): Promise<ReplyCache> {
  const now = Date.now();
  if (replyCache) {
    // Stale-while-revalidate: serve stale immediately, refresh in background
    if (replyCache.expiresAt <= now && !replyCachePromise) {
      fetchReplyCache(supabase).catch(() => {});
    }
    return replyCache;
  }
  return fetchReplyCache(supabase);
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
export const MAIN_KEYBOARD = {
  keyboard: [
    ["បន្ថែមពាក្យថ្មី"],
    ["បញ្ជីពាក្យ កែប្រែ&លុប"],
    ["⏱ កំណត់ Timer លុបសារ"],
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
  keyboard: [["👁 មើល", "✏️ កែ", "🗑 លុប"], ["⏱ Timer", "↕️ ទីតាំង"], ["❌ បោះបង់"]],
  resize_keyboard: true,
};

const POSITION_KEYBOARD = {
  keyboard: [["⬆️ ឡើងលើ", "⬇️ ចុះក្រោម"], ["⏫ ទៅដើម", "⏬ ទៅចុង"], ["❌ បោះបង់"]],
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
type ReplyContent =
  | { type: "copy"; from_chat_id: number; message_id: number; forward: boolean }
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
  if (rows.length > 0) {
    // Fire-and-forget: don't block webhook response on this bookkeeping insert
    supabase.from("pending_deletions").insert(rows).then(() => {}, (e: any) => console.error("pending_deletions insert failed", e));
  }
}

async function getEffectiveDeleteSeconds(supabase: any, match: any) {
  if (match.delete_after_seconds !== null && match.delete_after_seconds !== undefined) {
    return match.delete_after_seconds;
  }
  return loadConfig(supabase);
}

export function buildKeywordKeyboard(keys: string[]) {
  if (keys.length === 0) return undefined;
  const rows: string[][] = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2));
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
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
async function sendReplies(
  token: string,
  supabase: any,
  chatId: number,
  content: any,
  autoDeleteSeconds: number,
  replyMarkup?: any,
) {
  const list = Array.isArray(content) ? content : [content];
  const pendingRows = (await Promise.all(
    list.map((item, idx) =>
      sendReply(
        token,
        supabase,
        chatId,
        item,
        autoDeleteSeconds,
        idx === list.length - 1 ? replyMarkup : undefined,
      ),
    ),
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

    // Build persistent keyword keyboard (shown to all group members, stays forever)
    const groupKeys = await listKeywords(supabase);
    const groupKb = buildKeywordKeyboard(groupKeys);

    // When bot is added to the group → show the keyboard once
    const botAdded = Array.isArray(msg.new_chat_members) &&
      msg.new_chat_members.some((m: any) => m?.is_bot);
    const isStartCmd = text === "/start" || text?.startsWith("/start@");

    if ((botAdded || isStartCmd) && groupKb) {
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "⌨️",
        reply_markup: groupKb,
      });
      return;
    }

    if (text) {
      const match = await getReplyByKeyword(supabase, text.trim().toLowerCase());
      if (match) {
        // Re-attach keyboard so it persists forever in the group
        await deleteAndSendMatch(token, supabase, chatId, msg.message_id, match, groupKb);
      }
      // No match → stay silent (only the keyboard is visible)
    }
    return;
  }


  const isStart = text === "/start" || text?.startsWith("/start@");

  // Private chat (non-admin): show keyword keyboard on every interaction so
  // it always reappears even after the user clears chat history.
  const keys = await listKeywords(supabase);
  const kb = buildKeywordKeyboard(keys);

  if (isStart) {
    if (keys.length === 0) {
      await tgRequest(token, "sendMessage", { chat_id: chatId, text: "សួស្តី! 👋" });
      return;
    }
    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `📋 បញ្ជីពាក្យឆ្លើយតប (${keys.length} ពាក្យ)\n\nសូមជ្រើសរើសពាក្យ៖`,
      reply_markup: kb,
    });
    return;
  }

  if (text) {
    const match = await getReplyByKeyword(supabase, text.trim().toLowerCase());
    if (match) {
      await deleteAndSendMatch(token, supabase, chatId, msg.message_id, match, kb);
    } else if (kb) {
      // No match: still re-show keyboard so user can pick a valid keyword
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "សូមជ្រើសរើសពាក្យពីខាងក្រោម៖",
        reply_markup: kb,
      });
    }
  }
}

export async function handleMessage(token: string, adminId: number, supabase: any, msg: any) {
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

    if (text === "↕️ ទីតាំង") {
      const keys = await listKeywords(supabase);
      const idx = keys.indexOf(kw);
      const total = keys.length;
      const pos = idx < 0 ? "?" : `${idx + 1}/${total}`;
      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `↕️ កំណត់ទីតាំងសម្រាប់ [${kw}]\n\n📍 ទីតាំងបច្ចុប្បន្ន: ${pos}\n\nសូមជ្រើសរើសទិសផ្លាស់ទី៖`,
        reply_markup: POSITION_KEYBOARD,
      });
      return;
    }

    if (
      text === "⬆️ ឡើងលើ" ||
      text === "⬇️ ចុះក្រោម" ||
      text === "⏫ ទៅដើម" ||
      text === "⏬ ទៅចុង"
    ) {
      const { data: rows } = await supabase
        .from("replies")
        .select("keyword, position")
        .order("position")
        .order("created_at");
      const list: any[] = rows ?? [];
      const idx = list.findIndex((r) => String(r.keyword).toLowerCase() === kw);
      if (idx < 0) {
        await tgRequest(token, "sendMessage", { chat_id: chatId, text: "⚠️ រកមិនឃើញពាក្យ។", reply_markup: ACTION_KEYBOARD });
        return;
      }

      // Normalize positions to 10,20,30... to give room to move
      const normalized = list.map((r, i) => ({ keyword: r.keyword, position: (i + 1) * 10 }));

      let newIdx = idx;
      if (text === "⬆️ ឡើងលើ") newIdx = Math.max(0, idx - 1);
      else if (text === "⬇️ ចុះក្រោម") newIdx = Math.min(list.length - 1, idx + 1);
      else if (text === "⏫ ទៅដើម") newIdx = 0;
      else if (text === "⏬ ទៅចុង") newIdx = list.length - 1;

      if (newIdx === idx && list.length > 1) {
        await tgRequest(token, "sendMessage", {
          chat_id: chatId,
          text: `⚠️ ពាក្យ [${kw}] នៅ${text === "⬆️ ឡើងលើ" || text === "⏫ ទៅដើម" ? "ដើម" : "ចុង"}បញ្ជីរួចហើយ។`,
          reply_markup: POSITION_KEYBOARD,
        });
        return;
      }

      // Move item to new index
      const [moved] = normalized.splice(idx, 1);
      normalized.splice(newIdx, 0, moved);
      // Re-assign positions
      const updates = normalized.map((r, i) => ({ keyword: r.keyword, position: (i + 1) * 10 }));
      // Batch update via upsert on keyword (need content NOT NULL — so use individual updates)
      await Promise.all(
        updates.map((u) =>
          supabase.from("replies").update({ position: u.position }).eq("keyword", u.keyword),
        ),
      );
      clearReplyCache();

      await tgRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `✅ បានផ្លាស់ទី [${kw}] → ទីតាំង ${newIdx + 1}/${updates.length}`,
        reply_markup: POSITION_KEYBOARD,
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
      // Parallelize delete + send; re-attach MAIN_KEYBOARD so it persists
      // even after the admin clears chat history.
      await Promise.all([
        tgRequest(token, "deleteMessage", {
          chat_id: chatId,
          message_id: msg.message_id,
        }).catch(() => {}),
        sendReplies(token, supabase, chatId, match.content, 0, MAIN_KEYBOARD),
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

        const msg = update.message ?? update.edited_message;

        // ---- FAST PATH: group keyword match with single reply ----
        // Respond to Telegram with the send method inline in this HTTP
        // response body — saves one full API round-trip per reply.
        try {
          if (msg?.chat?.id && (msg.chat.type === "group" || msg.chat.type === "supergroup") && msg.text) {
            const { supabaseAdmin } = await getAdminClient();
            const cache = replyCache; // sync peek; only take fast path when cache is hot
            if (cache) {
              const match = cache.replies.get(msg.text.trim().toLowerCase());
              if (match && !Array.isArray(match.content)) {
                const chatId = msg.chat.id;
                const effective = match.delete_after_seconds ?? cache.config;

                // Fire-and-forget: delete user message + group tracking + schedule bot-message deletion
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
                  // Attach persistent keyword keyboard so it stays forever in the group
                  const keys = Array.from(cache.replies.keys());
                  const kb = buildKeywordKeyboard(keys);
                  if (kb) inline.reply_markup = kb;
                  // We can't get the sent message_id from an inline response,
                  // so auto-delete for inline sends is best-effort skipped.
                  if (effective > 0) {
                    // Fallback to normal path so pending_deletions is recorded
                  } else {
                    return new Response(JSON.stringify(inline), {
                      status: 200,
                      headers: { "Content-Type": "application/json" },
                    });
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("Telegram fast-path error:", err);
        }

        // ---- Normal path ----
        try {
          const { supabaseAdmin } = await getAdminClient();
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

