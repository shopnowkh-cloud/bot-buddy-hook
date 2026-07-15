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

    if (url.pathname === "/api/miniapp") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "content-type",
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
      const upstream = await fetch(env.BOT_SYNC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bridge-secret": env.BOT_SYNC_SECRET,
        },
        body,
      });

      // Relay status + body; strip hop-by-hop headers.
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
