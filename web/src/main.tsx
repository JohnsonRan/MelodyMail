import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { detectLocale, initI18n } from "./i18n";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

const locale = detectLocale();
await initI18n(locale);

createRoot(root).render(
  <StrictMode>
    <App initialLocale={locale} />
  </StrictMode>,
);
