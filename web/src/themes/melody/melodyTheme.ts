import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

// The app's theme: Astryx neutral plus one toast type. "mail" is the new-mail notice
// (web/src/mailbox/notice.tsx, owner ruling 2026-11-16): a raised card on the page's own surface,
// so it reads apart from the inverted toasts used for "Saved" and errors. The toast measures its
// painted surface (MediaTheme auto), so its content takes the page's light or dark tokens.
export const melodyTheme = defineTheme({
  name: "melody",
  extends: neutralTheme,
  components: {
    banner: { base: { userSelect: "text", WebkitUserSelect: "text" } },
    code: { base: { userSelect: "text", WebkitUserSelect: "text" } },
    "text-input": { base: { userSelect: "text", WebkitUserSelect: "text" } },
    tokenizer: { base: { userSelect: "text", WebkitUserSelect: "text" } },
    "text-area": { base: { userSelect: "text", WebkitUserSelect: "text" } },
    toast: {
      "type:mail": {
        backgroundColor: "var(--color-background-card)",
        color: "var(--color-text-primary)",
        borderWidth: "var(--border-width)",
        borderStyle: "solid",
        borderColor: "var(--color-border-emphasized)",
        boxShadow: "var(--shadow-high)",
      },
    },
  },
  // Touch targets (REQUIREMENTS.md, "Touch target, coarse pointer"): where the primary pointer
  // is a finger, every control size is at least 44 CSS px tall; icon buttons are square.
  adaptations: {
    rules: [
      {
        when: { pointer: "coarse" },
        value: {
          tokens: {
            "--size-element-sm": "44px",
            "--size-element-md": "44px",
            "--size-element-lg": "44px",
          },
        },
      },
    ],
  },
});
