export const MODES = ["system", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

const STORAGE_KEY = "melodymail.mode";

export function readMode(): Mode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (MODES as readonly string[]).includes(stored)) return stored as Mode;
  } catch {
    // Storage unavailable: follow the system setting.
  }
  return "system";
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // The choice then lasts for this visit only.
  }
}
