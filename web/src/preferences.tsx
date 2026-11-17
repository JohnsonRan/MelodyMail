import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { ComputerDesktopIcon, LanguageIcon, MoonIcon, SunIcon } from "@heroicons/react/24/outline";
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

const MODE_ICON: Record<Mode, typeof SunIcon> = {
  system: ComputerDesktopIcon,
  light: SunIcon,
  dark: MoonIcon,
};

/** An icon button that opens a menu of choices, the current one checked (menuitemradio). */
function ChoiceMenu({
  label,
  icon,
  value,
  onChange,
  options,
}: {
  label: string;
  icon: typeof SunIcon;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <DropdownMenu
      alignment="end"
      renderTrigger={(props) => (
        <IconButton {...props} label={label} icon={<Icon icon={icon} />} variant="ghost" />
      )}
    >
      <DropdownMenuRadioGroup label={label} value={value} onChange={onChange}>
        {options.map((o) => (
          <DropdownMenuRadioItem key={o.value} value={o.value} label={o.label} />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}

/**
 * Language and theme as icon buttons, shared by the app bar and the sign-in pages: each opens a
 * menu with the choices by name. The theme icon shows the current mode; both names say the
 * current choice. Languages are listed by their own names.
 */
export function PreferenceMenus() {
  const { t } = useTranslation();
  const { locale, mode, setLocale, setMode } = usePreferences();
  return (
    <HStack gap={1}>
      <ChoiceMenu
        label={t("settings.languageButton", { language: t(`language.${locale}`) })}
        icon={LanguageIcon}
        value={locale}
        onChange={(value) => setLocale(value as Locale)}
        options={LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
      />
      <ChoiceMenu
        label={t("settings.themeButton", { mode: t(`theme.${mode}`) })}
        icon={MODE_ICON[mode]}
        value={mode}
        onChange={(value) => setMode(value as Mode)}
        options={MODES.map((m) => ({ value: m, label: t(`theme.${m}`) }))}
      />
    </HStack>
  );
}
