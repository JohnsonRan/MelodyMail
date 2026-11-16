import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Rolldown } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The Astryx neutral theme's page background (--color-background-body, light): a manifest needs
// a literal colour, and the address bar matches the app's own.
const BACKGROUND = "#f1f1f1";

/**
 * True for a module that the HTML entry reaches through static imports, i.e. one the first paint
 * loads. The libraries among them go in one "vendor" chunk: otherwise a lazy chunk that shares
 * some of them (compose shares Astryx modules) makes the bundler cut those out into more
 * preloaded chunks, which cost 3.9 kB gzip of first paint for the same code (docs/STATE.md, M5).
 * The app's own code and every lazy chunk keep the automatic split.
 */
function inFirstPaint(id: string, ctx: Rolldown.ChunkingContext): boolean {
  const seen = new Set([id]);
  const queue = [id];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const info = ctx.getModuleInfo(next);
    if (!info) continue;
    if (info.isEntry) return next !== id;
    for (const importer of info.importers) {
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return false;
}

// In development the Worker runs under `wrangler dev` on its default port; the SPA proxies
// /api there so the browser still talks to a single origin, as it does in production.
// ws: the live-update socket (/api/events) is a WebSocket upgrade, which the proxy passes on only
// with this flag.
export default defineConfig({
  plugins: [
    react(),
    // docs/M4b-pwa.md: our own service worker (src/sw.ts) precaches the shell; the app registers
    // it after the first render (src/pwa/register.ts), so nothing is injected into index.html.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      injectManifest: {
        // Hashed build output, index.html, the manifest and the icons. The woff fallbacks are
        // left out: every browser that runs a service worker reads woff2.
        globPatterns: ["**/*.{js,css,html,woff2,png,svg,ico,webmanifest}"],
      },
      manifest: {
        // The brand is not translated; the manifest is one file for every locale.
        name: "MelodyMail",
        short_name: "MelodyMail",
        description: "Your own mail service on Cloudflare.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: BACKGROUND,
        background_color: BACKGROUND,
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    // The neutral theme's fonts.css loads Figtree from Google. The app imports src/fonts.css
    // itself (src/main.tsx); the alias keeps Google out should a generated module import the
    // neutral file again.
    alias: {
      "@astryxdesign/theme-neutral/fonts.css": fileURLToPath(
        new URL("./src/fonts.css", import.meta.url),
      ),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: (id, ctx) =>
                id.includes("/node_modules/") && inFirstPaint(id, ctx) ? "vendor" : null,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } },
  },
});
