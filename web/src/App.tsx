import { AppShell } from "@astryxdesign/core/AppShell";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import jaJP from "@astryxdesign/core/locales/ja-JP.generated.js";
import zhCN from "@astryxdesign/core/locales/zh-CN.generated.js";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { HStack } from "@astryxdesign/core/Stack";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { Theme } from "@astryxdesign/core/theme";
import {
  ArchiveBoxIcon,
  Cog6ToothIcon,
  DocumentIcon,
  EnvelopeIcon,
  InboxIcon,
  PaperAirplaneIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import i18next from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultThemeSlug, themes } from "./astryx-themes";
import { LOCALES, type Locale, saveLocale } from "./i18n";
import { MODES, type Mode, readMode, saveMode } from "./mode";

const astryxMessages = { "zh-CN": zhCN, "ja-JP": jaJP };

export function App({ initialLocale }: { initialLocale: Locale }) {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [mode, setMode] = useState<Mode>(readMode);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.name");
  }, [locale, t]);

  const changeLocale = (value: string) => {
    const next = value as Locale;
    void i18next.changeLanguage(next).then(() => setLocale(next));
    saveLocale(next);
  };

  const changeMode = (value: string) => {
    const next = value as Mode;
    setMode(next);
    saveMode(next);
  };

  return (
    <Theme theme={themes[defaultThemeSlug]} mode={mode}>
      <InternationalizationProvider locale={locale} messages={astryxMessages}>
        <AppShell
          contentPadding={6}
          style={{ height: "100dvh", minHeight: 0 }}
          topNav={
            <TopNav
              label={t("nav.main")}
              heading={
                <TopNavHeading heading={t("app.name")} logo={<NavIcon icon={<EnvelopeIcon />} />} />
              }
              endContent={
                <HStack gap={2}>
                  <Selector
                    label={t("settings.language")}
                    isLabelHidden
                    variant="ghost"
                    size="sm"
                    value={locale}
                    onChange={changeLocale}
                    options={LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
                  />
                  <Selector
                    label={t("settings.theme")}
                    isLabelHidden
                    variant="ghost"
                    size="sm"
                    value={mode}
                    onChange={changeMode}
                    options={MODES.map((m) => ({ value: m, label: t(`theme.${m}`) }))}
                  />
                </HStack>
              }
            />
          }
          sideNav={
            <SideNav>
              <SideNavSection title={t("nav.mail")} isHeaderHidden>
                <SideNavItem label={t("folder.inbox")} icon={InboxIcon} isSelected href="#" />
                <SideNavItem label={t("folder.sent")} icon={PaperAirplaneIcon} href="#" />
                <SideNavItem label={t("folder.drafts")} icon={DocumentIcon} href="#" />
                <SideNavItem label={t("folder.archive")} icon={ArchiveBoxIcon} href="#" />
                <SideNavItem label={t("folder.trash")} icon={TrashIcon} href="#" />
              </SideNavSection>
              <SideNavSection title={t("nav.manage")}>
                <SideNavItem label={t("nav.settings")} icon={Cog6ToothIcon} href="#" />
              </SideNavSection>
            </SideNav>
          }
        >
          <EmptyState
            headingLevel={1}
            icon={<InboxIcon />}
            title={t("inbox.emptyTitle")}
            description={t("inbox.emptyDescription")}
          />
        </AppShell>
      </InternationalizationProvider>
    </Theme>
  );
}
