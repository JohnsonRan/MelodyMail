import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Worker runs under `wrangler dev` on its default port; the SPA proxies
// /api there so the browser still talks to a single origin, as it does in production.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
