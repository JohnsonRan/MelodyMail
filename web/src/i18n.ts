import i18next, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";

export const LOCALES = ["zh-CN", "en", "ja-JP"] as const;
export type Locale = (typeof LOCALES)[number];

const STORAGE_KEY = "melodymail.locale";

// One chunk per locale, so a reader downloads only the language in use.
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json");

const lazyBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language, namespace, callback) {
    const load = catalogs[`./locales/${language}/${namespace}.json`];
    if (!load) return callback(new Error(`missing catalog ${language}/${namespace}`), false);
    load().then(
      (mod) => callback(null, mod.default),
      (err: Error) => callback(err, false),
    );
  },
};

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Saved choice first, then the browser's languages by base language, then English. */
export function detectLocale(): Locale {
  const stored = readStored();
  if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;
  for (const tag of navigator.languages) {
    const base = tag.toLowerCase().split("-")[0];
    const match = LOCALES.find((l) => l.toLowerCase().split("-")[0] === base);
    if (match) return match;
  }
  return "en";
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this visit only.
  }
}

export async function initI18n(locale: Locale): Promise<void> {
  await i18next
    .use(lazyBackend)
    .use(initReactI18next)
    .init({
      lng: locale,
      supportedLngs: LOCALES,
      fallbackLng: "en",
      ns: ["common"],
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
}
