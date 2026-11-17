import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme, useTheme } from "@astryxdesign/core/theme";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { type AnchorHTMLAttributes, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { defaultThemeSlug, themes } from "./astryx-themes";
import type { AstryxMessages, Locale } from "./i18n";
import { PreferencesProvider } from "./preferences";
import { disableChromeSelection } from "./selection";

/**
 * Every Astryx link to a page navigates through the router instead of reloading the page. A
 * download or a Worker URL (/api/...) stays a plain anchor: the router would cancel the click and
 * look for a page of that name.
 */
function RouterLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (props.download !== undefined || href?.startsWith("/api/")) {
    return <a href={href} {...props} />;
  }
  return <Link to={href ?? "/"} {...props} />;
}

/** After a route change, focus starts at the page title (web/AGENTS.md, Accessibility). */
function useFocusTitleOnNavigate() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const title = document.querySelector("h1");
    if (title instanceof HTMLElement) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, [pathname]);
}

/**
 * Registers the service worker once the page has loaded, from its own chunk, so registration
 * is not part of first paint (docs/M4b-pwa.md, "Service worker and caching").
 */
function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const start = () => void import("./pwa/register");
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  }, []);
}

function DocumentMeta({ locale }: { locale: Locale }) {
  const { t } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.name");
  }, [locale, t]);
  return null;
}

/**
 * The browser's bar colour (theme-color) follows the resolved theme, so a manual light or dark
 * choice changes it too. index.html carries a light and a dark tag for the first paint; this
 * keeps one, with the page's --color-background-body.
 */
function ThemeColor() {
  const { mode } = useTheme();
  // biome-ignore lint/correctness/useExhaustiveDependencies: mode is the trigger, not an input.
  useEffect(() => {
    // The next frame: Theme writes the mode to the root element in its own effect.
    const frame = requestAnimationFrame(() => {
      const root = getComputedStyle(document.documentElement);
      const color = root.getPropertyValue("--color-background-body").trim();
      const [meta, ...rest] = document.querySelectorAll('meta[name="theme-color"]');
      for (const extra of rest) extra.remove();
      meta?.removeAttribute("media");
      if (color) meta?.setAttribute("content", color);
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);
  return null;
}

export function RootLayout({
  initialLocale,
  initialMessages,
}: {
  initialLocale: Locale;
  initialMessages: AstryxMessages;
}) {
  useFocusTitleOnNavigate();
  useServiceWorker();
  useLayoutEffect(disableChromeSelection, []);
  return (
    <PreferencesProvider initialLocale={initialLocale} initialMessages={initialMessages}>
      {({ locale, mode, astryxMessages }) => (
        <Theme theme={themes[defaultThemeSlug]} mode={mode}>
          <InternationalizationProvider locale={locale} messages={astryxMessages}>
            <LinkProvider component={RouterLink}>
              <DocumentMeta locale={locale} />
              <ThemeColor />
              <Outlet />
            </LinkProvider>
          </InternationalizationProvider>
        </Theme>
      )}
    </PreferencesProvider>
  );
}
