import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { type AnchorHTMLAttributes, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { defaultThemeSlug, themes } from "./astryx-themes";
import type { AstryxMessages, Locale } from "./i18n";
import { PreferencesProvider } from "./preferences";

/** Every Astryx link navigates through the router instead of reloading the page. */
function RouterLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
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

function DocumentMeta({ locale }: { locale: Locale }) {
  const { t } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.name");
  }, [locale, t]);
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
  return (
    <PreferencesProvider initialLocale={initialLocale} initialMessages={initialMessages}>
      {({ locale, mode, astryxMessages }) => (
        <Theme theme={themes[defaultThemeSlug]} mode={mode}>
          <InternationalizationProvider locale={locale} messages={astryxMessages}>
            <LinkProvider component={RouterLink}>
              <DocumentMeta locale={locale} />
              <Outlet />
            </LinkProvider>
          </InternationalizationProvider>
        </Theme>
      )}
    </PreferencesProvider>
  );
}
