import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// Icons for the manifest and the page head, generated from public/logo.svg with
// `bun run icons` and committed. The padding colour is the logo's own background, Astryx
// neutral accent (--color-accent in the light theme).
const background = "#1b1b1b";

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background } },
  },
  images: ["public/logo.svg"],
});
