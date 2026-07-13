import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MAIN_KEYBOARD,
  buildKeywordKeyboard,
  handleUserMessage,
  handleMessage,
  clearReplyCache,
} from "./webhook";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type TgCall = { method: string; body: any };

function installFetchSpy(): TgCall[] {
  const calls: TgCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const m = String(url).match(/\/bot[^/]+\/(\w+)$/);
      const method = m ? m[1] : "unknown";
      const body = JSON.parse(init.body);
      calls.push({ method, body });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 999 } }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

/**
 * Minimal in-memory Supabase mock — only the tables/columns the handlers touch.
 * Returns a Postgrest-like chain object.
 */
function makeSupabase({
  replies = [] as Array<{ keyword: string; content: any; delete_after_seconds: number | null }>,
  config = 0 as number,
  states = new Map<number, any>(),
} = {}) {
  function table(name: string) {
    return {
      select() {
        return {
          order: () => Promise.resolve({ data: name === "replies" ? replies : [] }),
          eq(_col: string, val: any) {
            return {
              maybeSingle: () => {
                if (name === "bot_config") return Promise.resolve({ data: { delete_after_seconds: config } });
                if (name === "bot_state") {
                  const s = states.get(val);
                  return Promise.resolve({ data: s ?? null });
                }
                return Promise.resolve({ data: null });
              },
            };
          },
        };
      },
      upsert(row: any) {
        if (name === "bot_state") states.set(row.chat_id, row);
        return Promise.resolve({ data: null, error: null });
      },
      insert: () => Promise.resolve({ data: null, error: null }),
    } as any;
  }
  return { from: (name: string) => table(name) };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildKeywordKeyboard", () => {
  it("returns undefined when no keywords", () => {
    expect(buildKeywordKeyboard([])).toBeUndefined();
  });

  it("groups keys into rows of two and is persistent", () => {
    const kb = buildKeywordKeyboard(["a", "b", "c"]);
    expect(kb).toEqual({
      keyboard: [["a", "b"], ["c"]],
      resize_keyboard: true,
      is_persistent: true,
    });
  });
});

describe("MAIN_KEYBOARD", () => {
  it("is marked persistent so it survives chat-history clears", () => {
    expect(MAIN_KEYBOARD.is_persistent).toBe(true);
    expect(MAIN_KEYBOARD.resize_keyboard).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioural tests — keyboard persistence
// ---------------------------------------------------------------------------

describe("handleUserMessage — private chat keyboard persistence", () => {
  beforeEach(() => {
    clearReplyCache();
    vi.unstubAllGlobals();
  });

  it("re-attaches keyword keyboard on /start (simulating clear-history)", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });

    await handleUserMessage("TOKEN", supabase, {
      chat: { id: 42, type: "private" },
      message_id: 1,
      text: "/start",
    });

    const sendMsg = calls.find((c) => c.method === "sendMessage");
    expect(sendMsg).toBeDefined();
    expect(sendMsg!.body.reply_markup).toEqual({
      keyboard: [["hi"]],
      resize_keyboard: true,
      is_persistent: true,
    });
  });

  it("re-attaches keyword keyboard when user taps a known keyword", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });

    await handleUserMessage("TOKEN", supabase, {
      chat: { id: 42, type: "private" },
      message_id: 7,
      text: "hi",
    });

    // The reply send (sendMessage / copyMessage / forwardMessage) must carry the keyboard.
    const replySends = calls.filter((c) =>
      ["sendMessage", "copyMessage", "forwardMessage"].includes(c.method) &&
      c.body.chat_id === 42 &&
      c.body.reply_markup,
    );
    expect(replySends.length).toBeGreaterThan(0);
    expect(replySends.at(-1)!.body.reply_markup.is_persistent).toBe(true);
  });

  it("still re-shows keyword keyboard when text does not match a keyword", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });

    await handleUserMessage("TOKEN", supabase, {
      chat: { id: 42, type: "private" },
      message_id: 9,
      text: "random gibberish",
    });

    const sendMsg = calls.find((c) => c.method === "sendMessage");
    expect(sendMsg?.body.reply_markup?.is_persistent).toBe(true);
  });
});

describe("handleMessage — admin keyboard persistence", () => {
  beforeEach(() => {
    clearReplyCache();
    vi.unstubAllGlobals();
  });

  it("re-attaches MAIN_KEYBOARD on /start (admin clear-history flow)", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase();

    await handleMessage("TOKEN", 1, supabase, {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message_id: 1,
      text: "/start",
    });

    const sendMsg = calls.find((c) => c.method === "sendMessage");
    expect(sendMsg?.body.reply_markup).toEqual(MAIN_KEYBOARD);
  });

  it("re-attaches MAIN_KEYBOARD when admin types a stored keyword with no active state", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "ping", content: { type: "text", content: "pong" }, delete_after_seconds: 0 }],
    });

    await handleMessage("TOKEN", 1, supabase, {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message_id: 5,
      text: "ping",
    });

    const sendWithKb = calls.find(
      (c) =>
        ["sendMessage", "copyMessage", "forwardMessage"].includes(c.method) &&
        c.body.reply_markup?.is_persistent === true,
    );
    expect(sendWithKb).toBeDefined();
    expect(sendWithKb!.body.reply_markup).toEqual(MAIN_KEYBOARD);
  });
});
