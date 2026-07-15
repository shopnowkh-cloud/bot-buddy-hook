import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev: proxy API to the Lovable bot. Requires BOT_SYNC_SECRET
      // in a local .env and running `bun run wrangler dev` alongside if you
      // want the Worker script in the loop; otherwise this proxy talks
      // straight to Lovable for iteration.
      "/api/miniapp": {
        target: process.env.VITE_DEV_BOT_BRIDGE_URL || "https://bot-buddy-hook.lovable.app",
        changeOrigin: true,
        rewrite: () => "/api/public/bot/bridge",
      },
    },
  },
});
