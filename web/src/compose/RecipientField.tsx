import { Tokenizer } from "@astryxdesign/core/Tokenizer";
import {
  type SearchableItem,
  type SearchSource,
  TypeaheadItem,
} from "@astryxdesign/core/Typeahead";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { searchContacts } from "./api";

// To, Cc and Bcc as address chips (docs/M5-sending.md, "Screens"). Typed or pasted text becomes
// chips on Enter; a paste of several addresses splits on commas, semicolons and spaces. An entry
// that is not an address stays out and is named in the field's error. Typing also suggests
// addresses from sent and received mail (GET /api/contacts); a pick adds its address as a chip.

/** label is the address; name is the contact's display name, "" when none is known. */
type Item = SearchableItem<{ name: string }>;

/** The Worker's check (worker/src/send/validate.ts, isEmail), so a chip is never refused later. */
export function isEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\.]{2,}$/.test(value)
  );
}

const SUGGEST_DELAY_MS = 150;

async function fetchContacts(query: string): Promise<Item[]> {
  try {
    const { contacts } = await searchContacts(query);
    return contacts.map((c) => ({
      id: c.address.toLowerCase(),
      label: c.address,
      auxiliaryData: { name: c.name },
    }));
  } catch {
    // Suggestions are optional: a failed request shows none, and typing still adds chips.
    return [];
  }
}

/**
 * The field offers its "create" row for the typed text only once the search has answered, so
 * text that is already complete addresses answers at once with no suggestions: Enter right
 * after typing or pasting adds exactly what was typed. Other text waits SUGGEST_DELAY_MS (the
 * field's own debounce is off) and asks the Worker only for the last query typed.
 */
const contactSource = (): SearchSource<Item> => {
  let latest = 0;
  return {
    search(query) {
      const call = ++latest;
      const q = query.trim();
      const typed = q.split(/[\s,;]+/).filter(Boolean);
      if (typed.length === 0 || typed.every(isEmail)) return [];
      return new Promise((resolve) => setTimeout(resolve, SUGGEST_DELAY_MS)).then(() =>
        call === latest ? fetchContacts(q) : [],
      );
    },
    cancel() {
      latest++;
    },
    bootstrap: () => [],
  };
};

/**
 * The name over the address when a name is known. A row narrower than the address ends it with
 * an ellipsis (minWidth lets the row shrink); the title shows it on hover, and a pick shows it
 * whole as a chip.
 */
function Suggestion({ item }: { item: Item }) {
  const name = item.auxiliaryData?.name;
  const shown = name ? { ...item, label: name } : item;
  return (
    <div title={item.label} style={{ minWidth: 0 }}>
      <TypeaheadItem
        item={shown}
        description={name ? item.label : undefined}
        style={{ minWidth: 0 }}
      />
    </div>
  );
}

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
  const [contacts] = useState(contactSource);
  const items = value.map((address) => ({ id: address.toLowerCase(), label: address }));
  return (
    <Tokenizer<Item>
      label={label}
      searchSource={contacts}
      renderItem={(item) => <Suggestion item={item} />}
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
