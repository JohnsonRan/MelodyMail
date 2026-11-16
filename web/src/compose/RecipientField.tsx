import { Tokenizer } from "@astryxdesign/core/Tokenizer";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import { useState } from "react";
import { useTranslation } from "react-i18next";

// To, Cc and Bcc as address chips (docs/M5-sending.md, "Screens"). Typed or pasted text becomes
// chips on Enter; a paste of several addresses splits on commas, semicolons and spaces. An entry
// that is not an address stays out and is named in the field's error.

type Item = { id: string; label: string };

/** The Worker's check (worker/src/send/validate.ts, isEmail), so a chip is never refused later. */
export function isEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\.]{2,}$/.test(value)
  );
}

// No address book yet: the field only creates chips from what is typed.
const NO_SUGGESTIONS: SearchSource<Item> = { search: () => [], bootstrap: () => [] };

export function RecipientField({
  label,
  value,
  onChange,
  hasAutoFocus,
}: {
  label: string;
  value: string[];
  onChange: (addresses: string[]) => void;
  hasAutoFocus?: boolean;
}) {
  const { t } = useTranslation("compose");
  const [invalid, setInvalid] = useState<string | null>(null);
  const items = value.map((address) => ({ id: address.toLowerCase(), label: address }));
  return (
    <Tokenizer<Item>
      label={label}
      searchSource={NO_SUGGESTIONS}
      value={items}
      hasCreate
      debounceMs={0}
      presentation="popover"
      hasAutoFocus={hasAutoFocus}
      placeholder={t("recipientPlaceholder")}
      emptySearchText=""
      width="100%"
      status={
        invalid ? { type: "error", message: t("invalidAddress", { value: invalid }) } : undefined
      }
      onChange={(next, change) => {
        if (change.type !== "create") {
          setInvalid(null);
          onChange(next.map((i) => i.label));
          return;
        }
        const typed = change.item.label.split(/[\s,;]+/).filter(Boolean);
        const bad = typed.filter((a) => !isEmail(a));
        setInvalid(bad.length > 0 ? bad.join(", ") : null);
        const known = new Set(value.map((a) => a.toLowerCase()));
        const added = typed.filter(
          (a) => isEmail(a) && !known.has(a.toLowerCase()) && known.add(a.toLowerCase()),
        );
        if (added.length > 0) onChange([...value, ...added]);
      }}
    />
  );
}
