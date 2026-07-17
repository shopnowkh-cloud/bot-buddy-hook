/// <reference types="@cloudflare/workers-types" />

// Worker entry: proxies /api/miniapp requests to the Lovable bot's
// authenticated bridge, and serves the built SPA for everything else.

export interface Env {
  ASSETS: Fetcher;
  BOT_SYNC_URL: string;
  BOT_SYNC_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const checks: Record<string, unknown> = {
        worker: "ok",
        has_BOT_SYNC_URL: !!env.BOT_SYNC_URL,
        has_BOT_SYNC_SECRET: !!env.BOT_SYNC_SECRET,
        bot_sync_url: env.BOT_SYNC_URL ?? null,
        secret_length: env.BOT_SYNC_SECRET?.length ?? 0,
      };

      if (!env.BOT_SYNC_URL || !env.BOT_SYNC_SECRET) {
        return json({ status: "misconfigured", reason: "Missing BOT_SYNC_URL or BOT_SYNC_SECRET on the Worker", ...checks }, 500);
      }

      try {
        const started = Date.now();
        const upstream = await fetch(env.BOT_SYNC_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bridge-secret": env.BOT_SYNC_SECRET,
          },
          body: JSON.stringify({ action: "me" }),
        });
        const latency_ms = Date.now() - started;
        const text = await upstream.text();
        let upstreamBody: unknown = text;
        try { upstreamBody = JSON.parse(text); } catch {}

        if (upstream.status === 200) {
          return json({ status: "ok", message: "Bridge reachable and secret matches ✅", latency_ms, upstream_status: 200, ...checks });
        }
        if (upstream.status === 401) {
          return json({
            status: "secret_mismatch",
            message: "Bridge returned 401 — BOT_SYNC_SECRET on the Worker does NOT match Lovable ❌",
            latency_ms,
            upstream_status: 401,
            upstream_body: upstreamBody,
            ...checks,
          }, 401);
        }
        if (upstream.status === 500) {
          return json({
            status: "bridge_misconfigured",
            message: "Bridge reachable but Lovable side missing BOT_SYNC_SECRET",
            latency_ms,
            upstream_status: 500,
            upstream_body: upstreamBody,
            ...checks,
          }, 502);
        }
        return json({
          status: "unexpected",
          message: `Bridge returned HTTP ${upstream.status}`,
          latency_ms,
          upstream_status: upstream.status,
          upstream_body: upstreamBody,
          ...checks,
        }, 502);
      } catch (e: any) {
        return json({
          status: "unreachable",
          message: "Failed to reach bridge URL — check BOT_SYNC_URL is correct and public",
          error: e?.message ?? String(e),
          ...checks,
        }, 502);
      }
    }



    if (url.pathname === "/api/miniapp") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "content-type, x-init-data, x-admin-token",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (!env.BOT_SYNC_URL || !env.BOT_SYNC_SECRET) {
        return new Response(
          JSON.stringify({ error: "Worker missing BOT_SYNC_URL / BOT_SYNC_SECRET" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      const body = await request.text();
      const forwardHeaders: Record<string, string> = {
        "content-type": "application/json",
        "x-bridge-secret": env.BOT_SYNC_SECRET,
      };
      const initData = request.headers.get("x-init-data");
      if (initData) forwardHeaders["x-init-data"] = initData;
      const adminToken = request.headers.get("x-admin-token");
      if (adminToken) forwardHeaders["x-admin-token"] = adminToken;

      const upstream = await fetch(env.BOT_SYNC_URL, {
        method: "POST",
        headers: forwardHeaders,
        body,
      });

      const respHeaders = new Headers();
      const ct = upstream.headers.get("content-type");
      if (ct) respHeaders.set("content-type", ct);
      respHeaders.set("access-control-allow-origin", "*");
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: respHeaders,
      });
    }

    // Everything else: serve the SPA (assets binding handles SPA fallback).
    return env.ASSETS.fetch(request);
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

