import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Worker runs under `wrangler dev` on its default port; the SPA proxies
// /api there so the browser still talks to a single origin, as it does in production.
// ws: the live-update socket (/api/events) is a WebSocket upgrade, which the proxy passes on only
// with this flag.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } },
  },
});
