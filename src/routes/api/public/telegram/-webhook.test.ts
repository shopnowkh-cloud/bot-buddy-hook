import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/admin-config.server", () => ({
  isAdminUserId: vi.fn(async (id: number | undefined | null) => Number(id) === 1),
}));

// Shared holder so tests can swap the mocked supabaseAdmin per-case.
const __mockAdmin: { current: any } = { current: null };
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return __mockAdmin.current;
  },
}));

import {
  handleUserMessage,
  handleMessage,
  clearReplyCache,
  slugifyKeyword,
  parseSlashCommand,
  syncBotCommands,
  resetCommandsSyncSignature,
  Route as WebhookRoute,
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
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 999 } }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

function makeSupabase({
  replies = [] as Array<{ keyword: string; content: any; delete_after_seconds: number | null }>,
  config = 0 as number,
  states = new Map<number, any>(),
} = {}) {
  function table(name: string) {
    const result = Promise.resolve({ data: name === "replies" ? replies : [] });
    const orderChain: any = {
      order: () => orderChain,
      then: (r: any, e: any) => result.then(r, e),
      catch: (e: any) => result.catch(e),
    };
    return {
      select() {
        return {
          order: () => orderChain,
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

describe("slugifyKeyword", () => {
  it("lower-cases and replaces non [a-z0-9_] with underscores", () => {
    expect(slugifyKeyword("Hello World")).toBe("hello_world");
    expect(slugifyKeyword("QR-Code")).toBe("qr_code");
  });

  it("generates a deterministic fallback slug for non-ASCII (Khmer) input", () => {
    const a = slugifyKeyword("សួស្តី");
    const b = slugifyKeyword("សួស្តី");
    expect(a).toBe(b);
    expect(a).toMatch(/^cmd_[a-z0-9]+$/);
    expect(a.length).toBeLessThanOrEqual(32);
  });

  it("truncates to Telegram's 32-char limit", () => {
    expect(slugifyKeyword("a".repeat(100)).length).toBeLessThanOrEqual(32);
  });
});

describe("parseSlashCommand", () => {
  it("returns the command name without leading slash", () => {
    expect(parseSlashCommand("/qr")).toBe("qr");
  });
  it("strips @botname suffix", () => {
    expect(parseSlashCommand("/qr@my_bot foo")).toBe("qr");
  });
  it("returns null for non-command text", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncBotCommands — calls setMyCommands with slugified keywords
// ---------------------------------------------------------------------------

describe("syncBotCommands", () => {
  beforeEach(() => {
    clearReplyCache();
    resetCommandsSyncSignature();
    vi.unstubAllGlobals();
  });

  it("registers all keywords as slash commands via setMyCommands", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [
        { keyword: "QR Code", content: { type: "text", content: "x" }, delete_after_seconds: null },
        { keyword: "hi", content: { type: "text", content: "y" }, delete_after_seconds: null },
      ],
    });
    await syncBotCommands("TOKEN", supabase);
    const set = calls.find((c) => c.method === "setMyCommands");
    expect(set).toBeDefined();
    const cmds = set!.body.commands as Array<{ command: string; description: string }>;
    expect(cmds).toEqual([
      { command: "1", description: "QR Code" },
      { command: "2", description: "hi" },
    ]);
  });

  it("is idempotent — repeated calls with same keywords issue only one setMyCommands", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "y" }, delete_after_seconds: null }],
    });
    await syncBotCommands("TOKEN", supabase);
    await syncBotCommands("TOKEN", supabase);
    expect(calls.filter((c) => c.method === "setMyCommands").length).toBe(1);
  });

  it("dedups concurrent parallel calls — only one setMyCommands is issued", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "y" }, delete_after_seconds: null }],
    });
    await Promise.all([
      syncBotCommands("TOKEN", supabase),
      syncBotCommands("TOKEN", supabase),
      syncBotCommands("TOKEN", supabase),
    ]);
    expect(calls.filter((c) => c.method === "setMyCommands").length).toBe(1);
  });

  it("re-syncs after resetCommandsSyncSignature() (e.g. keyword mutation)", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "y" }, delete_after_seconds: null }],
    });
    await syncBotCommands("TOKEN", supabase);
    resetCommandsSyncSignature();
    clearReplyCache();
    await syncBotCommands("TOKEN", supabase);
    expect(calls.filter((c) => c.method === "setMyCommands").length).toBe(2);
  });

  it("no-ops when token is empty", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "y" }, delete_after_seconds: null }],
    });
    await syncBotCommands("", supabase);
    expect(calls.filter((c) => c.method === "setMyCommands").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Webhook POST — auto-sync on every incoming update
// ---------------------------------------------------------------------------

describe("webhook POST — auto-sync on every update", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    clearReplyCache();
    resetCommandsSyncSignature();
    vi.unstubAllGlobals();
    vi.resetModules();
    process.env.TELEGRAM_BOT_TOKEN = "TOKEN";
    process.env.ADMIN_CHAT_ID = "1";
    process.env.TELEGRAM_WEBHOOK_SECRET = "SECRET";
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "key";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  async function loadRouteWithSupabase(supabase: any) {
    vi.doMock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: supabase }));
    const mod = await import("./webhook");
    mod.clearReplyCache();
    mod.resetCommandsSyncSignature();
    return mod;
  }

  function makeReq(body: any, secretOk = true) {
    const { createHash } = require("crypto");
    const derived = createHash("sha256").update(`telegram-webhook:SECRET`).digest("base64url");
    return new Request("http://localhost/api/public/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secretOk ? derived : "wrong",
      },
      body: JSON.stringify(body),
    });
  }

  it("triggers setMyCommands on incoming update (auto-sync)", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "y" }, delete_after_seconds: null }],
    });
    const mod = await loadRouteWithSupabase(supabase);
    const handler = (mod as any).Route.options.server.handlers.POST;

    await handler({
      request: makeReq({ update_id: 1, message: { chat: { id: 42, type: "private" }, from: { id: 999 }, message_id: 1, text: "hello" } }),
    });
    // Let fire-and-forget microtasks flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.method === "setMyCommands")).toBe(true);
  });

  it("dedups auto-sync across multiple sequential webhook updates", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "y" }, delete_after_seconds: null }],
    });
    const mod = await loadRouteWithSupabase(supabase);
    const handler = (mod as any).Route.options.server.handlers.POST;

    for (let i = 0; i < 3; i++) {
      await handler({
        request: makeReq({ update_id: i, message: { chat: { id: 42, type: "private" }, from: { id: 999 }, message_id: i, text: "x" } }),
      });
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls.filter((c) => c.method === "setMyCommands").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// User message handling — slash commands only, no keyboard
// ---------------------------------------------------------------------------

describe("handleUserMessage — slash commands", () => {
  beforeEach(() => {
    clearReplyCache();
    resetCommandsSyncSignature();
    vi.unstubAllGlobals();
  });

  it("responds to /keyword in a group with the matching reply", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });
    await handleUserMessage("TOKEN", supabase, {
      chat: { id: -100, type: "group" },
      from: { id: 10 },
      message_id: 1,
      text: "/1",
    });
    const sent = calls.find((c) => c.method === "sendMessage" && c.body.text === "hello");
    expect(sent).toBeDefined();
    // No persistent keyboard should be attached anywhere.
    for (const c of calls) {
      expect(c.body.reply_markup).toBeUndefined();
    }
  });

  it("responds to /keyword@botname in a group", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });
    await handleUserMessage("TOKEN", supabase, {
      chat: { id: -100, type: "group" },
      from: { id: 10 },
      message_id: 2,
      text: "/1@my_bot",
    });
    expect(calls.some((c) => c.method === "sendMessage" && c.body.text === "hello")).toBe(true);
  });

  it("does nothing for random group text (no keyword-matching by plain text)", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });
    await handleUserMessage("TOKEN", supabase, {
      chat: { id: -100, type: "group" },
      from: { id: 10 },
      message_id: 3,
      text: "hi",
    });
    expect(calls.length).toBe(0);
  });

  it("/start in group syncs the command menu but sends no keyboard", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });
    await handleUserMessage("TOKEN", supabase, {
      chat: { id: -100, type: "group" },
      from: { id: 10 },
      message_id: 4,
      text: "/start",
    });
    // Command sync should fire; no sendMessage carrier / keyboard.
    // Wait a tick for the fire-and-forget promise.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.method === "setMyCommands")).toBe(true);
    expect(calls.every((c) => c.method !== "sendMessage")).toBe(true);
  });

  it("/start in private lists commands", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "hi", content: { type: "text", content: "hello" }, delete_after_seconds: null }],
    });
    await handleUserMessage("TOKEN", supabase, {
      chat: { id: 42, type: "private" },
      message_id: 5,
      text: "/start",
    });
    const listMsg = calls.find(
      (c) => c.method === "sendMessage" && String(c.body.text ?? "").includes("/1"),
    );
    expect(listMsg).toBeDefined();
    expect(listMsg!.body.reply_markup).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Admin message handling — slash commands in admin private chat
// ---------------------------------------------------------------------------

describe("handleMessage — admin slash command fallback", () => {
  beforeEach(() => {
    clearReplyCache();
    resetCommandsSyncSignature();
    vi.unstubAllGlobals();
  });

  it("admin typing /keyword in private with no active state sends the reply", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "ping", content: { type: "text", content: "pong" }, delete_after_seconds: 0 }],
    });
    await handleMessage("TOKEN", 1, supabase, {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message_id: 5,
      text: "/1",
    });
    const sent = calls.find((c) => c.method === "sendMessage" && c.body.text === "pong");
    expect(sent).toBeDefined();
  });

  it("admin typing raw keyword (no slash) is NOT sent as a reply", async () => {
    const calls = installFetchSpy();
    const supabase = makeSupabase({
      replies: [{ keyword: "ping", content: { type: "text", content: "pong" }, delete_after_seconds: 0 }],
    });
    await handleMessage("TOKEN", 1, supabase, {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message_id: 6,
      text: "ping",
    });
    expect(calls.every((c) => !(c.method === "sendMessage" && c.body.text === "pong"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Album flow still works via slash command
// ---------------------------------------------------------------------------

describe("album flow via slash command — media_group_id grouping", () => {
  beforeEach(() => {
    clearReplyCache();
    resetCommandsSyncSignature();
    vi.unstubAllGlobals();
  });

  it("groups album into ONE copyMessages call, sorted by message_id", async () => {
    const calls = installFetchSpy();
    const albumContent = [
      { type: "copy", from_chat_id: 100, message_id: 52, forward: false, media_group_id: "ALBUM_A" },
      { type: "copy", from_chat_id: 100, message_id: 50, forward: false, media_group_id: "ALBUM_A" },
      { type: "copy", from_chat_id: 100, message_id: 51, forward: false, media_group_id: "ALBUM_A" },
    ];
    const supabase = makeSupabase({
      replies: [{ keyword: "album", content: albumContent, delete_after_seconds: null }],
    });
    await handleUserMessage("TOKEN", supabase, {
      chat: { id: 555, type: "group" },
      message_id: 1,
      text: "/1",
    });
    const copyMessagesCalls = calls.filter((c) => c.method === "copyMessages");
    expect(copyMessagesCalls.length).toBe(1);
    expect(copyMessagesCalls[0].body).toMatchObject({
      chat_id: 555,
      from_chat_id: 100,
      message_ids: [50, 51, 52],
    });
  });
});
