import { useEffect, useRef } from "react";

// Gmail-style shortcuts (docs/M4-mailbox.md, "Keyboard"). They are off while focus is in a text
// field, and with Ctrl, Alt or Meta held, so typing and browser shortcuts are untouched.

export type ShortcutHandlers = {
  next: () => void;
  previous: () => void;
  open: () => void;
  archive: () => void;
  trash: () => void;
  star: () => void;
  back: () => void;
  search: () => void;
};

function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useMailShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      if (inTextField(event.target)) return;
      // A focused button or link keeps its own Enter.
      if (
        event.key === "Enter" &&
        event.target instanceof HTMLElement &&
        event.target !== document.body
      ) {
        return;
      }
      const map: Record<string, keyof ShortcutHandlers> = {
        j: "next",
        k: "previous",
        Enter: "open",
        e: "archive",
        "#": "trash",
        s: "star",
        u: "back",
        "/": "search",
      };
      const name = map[event.key];
      if (!name) return;
      event.preventDefault();
      ref.current[name]();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
