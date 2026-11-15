import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { detectLocale, initI18n, withAstryxMessages } from "./i18n";
import { buildRouter } from "./router";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

const locale = detectLocale();
const [messages] = await Promise.all([withAstryxMessages({}, locale), initI18n(locale)]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={buildRouter(locale, messages)} />
  </StrictMode>,
);
