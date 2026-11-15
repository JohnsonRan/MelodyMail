import { Selector } from "@astryxdesign/core/Selector";
import { HStack } from "@astryxdesign/core/Stack";
import i18next from "i18next";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AstryxMessages, LOCALES, type Locale, saveLocale, withAstryxMessages } from "./i18n";
import { MODES, type Mode, readMode, saveMode } from "./mode";

type Preferences = {
  locale: Locale;
  mode: Mode;
  astryxMessages: AstryxMessages;
  setLocale: (locale: Locale) => void;
  setMode: (mode: Mode) => void;
};

const PreferencesContext = createContext<Preferences | null>(null);

export function PreferencesProvider({
  initialLocale,
  initialMessages,
  children,
}: {
  initialLocale: Locale;
  initialMessages: AstryxMessages;
  children: (prefs: Preferences) => ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [mode, setModeState] = useState<Mode>(readMode);
  const [astryxMessages, setAstryxMessages] = useState(initialMessages);
  const prefs: Preferences = {
    locale,
    mode,
    astryxMessages,
    setLocale: (next) => {
      saveLocale(next);
      void Promise.all([
        withAstryxMessages(astryxMessages, next),
        i18next.changeLanguage(next),
      ]).then(([messages]) => {
        setAstryxMessages(messages);
        setLocaleState(next);
      });
    },
    setMode: (next) => {
      setModeState(next);
      saveMode(next);
    },
  };
  return <PreferencesContext.Provider value={prefs}>{children(prefs)}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  const prefs = useContext(PreferencesContext);
  if (!prefs) throw new Error("usePreferences outside PreferencesProvider");
  return prefs;
}

/** Language and theme selectors, shared by the app bar and the sign-in pages. */
export function PreferenceSelectors() {
  const { t } = useTranslation();
  const { locale, mode, setLocale, setMode } = usePreferences();
  return (
    <HStack gap={2}>
      <Selector
        label={t("settings.language")}
        isLabelHidden
        variant="ghost"
        size="sm"
        value={locale}
        onChange={(value: string) => setLocale(value as Locale)}
        options={LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
      />
      <Selector
        label={t("settings.theme")}
        isLabelHidden
        variant="ghost"
        size="sm"
        value={mode}
        onChange={(value: string) => setMode(value as Mode)}
        options={MODES.map((m) => ({ value: m, label: t(`theme.${m}`) }))}
      />
    </HStack>
  );
}
