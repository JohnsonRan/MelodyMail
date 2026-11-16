import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FormDialog } from "../components/FormDialog";

export const SCOPES = ["mail:read", "mail:write", "mail:send"] as const;
export type Scope = (typeof SCOPES)[number];
/** The locale key of a scope: i18next reads ":" as its namespace separator. */
export const scopeKey = (s: Scope) => s.slice("mail:".length);
/** "never": a key that does not expire (owner ruling 3, docs/M6-rules-api.md). */
const EXPIRY = ["30", "90", "365", "never"] as const;

const LABEL_MAX = 64;

export type KeyDraft = { label: string; scopes: Scope[]; expiry: (typeof EXPIRY)[number] };

export const emptyKeyDraft = (): KeyDraft => ({ label: "", scopes: ["mail:read"], expiry: "90" });

/** The body of POST /api/keys. */
export const keyBody = (d: KeyDraft) => ({
  label: d.label.trim(),
  scopes: d.scopes,
  expiresInDays: d.expiry === "never" ? null : Number(d.expiry),
});

/** Create an API key: label, scopes and expiry. The page runs the request through re-auth. */
export function CreateKeyDialog({
  draft,
  isSubmitting,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: KeyDraft | null;
  isSubmitting: boolean;
  onChange: (draft: KeyDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation("apiKeys");
  const d = draft ?? emptyKeyDraft();
  const set = (patch: Partial<KeyDraft>) => onChange({ ...d, ...patch });
  // Field errors show after the first try to submit, so an empty new form is not red.
  const [tried, setTried] = useState(false);
  const label = d.label.trim();
  const labelError = !label
    ? t("labelRequired")
    : label.length > LABEL_MAX
      ? t("labelTooLong", { max: LABEL_MAX })
      : null;
  const scopesError = d.scopes.length === 0 ? t("scopesRequired") : null;
  const submit = () => {
    const valid = !labelError && !scopesError;
    setTried(!valid);
    if (valid) onSubmit();
  };
  const close = () => {
    setTried(false);
    onClose();
  };
  return (
    <FormDialog
      isOpen={draft !== null}
      onClose={close}
      title={t("createTitle")}
      submitLabel={t("create")}
      isSubmitting={isSubmitting}
      onSubmit={submit}
    >
      <TextInput
        label={t("label")}
        description={t("labelDescription")}
        value={d.label}
        onChange={(value) => set({ label: value })}
        isRequired
        status={tried && labelError ? { type: "error", message: labelError } : undefined}
        hasAutoFocus
      />
      <CheckboxList
        label={t("scopes")}
        value={d.scopes}
        onChange={(scopes) => set({ scopes: SCOPES.filter((s) => scopes.includes(s)) })}
        isRequired
        status={tried && scopesError ? { type: "error", message: scopesError } : undefined}
      >
        {SCOPES.map((s) => (
          <CheckboxListItem
            key={s}
            value={s}
            label={t(`scope.${scopeKey(s)}`)}
            description={t(`scopeDescription.${scopeKey(s)}`)}
          />
        ))}
      </CheckboxList>
      <RadioList
        label={t("expiry")}
        value={d.expiry}
        onChange={(expiry) => set({ expiry: expiry as KeyDraft["expiry"] })}
      >
        {EXPIRY.map((e) => (
          <RadioListItem key={e} value={e} label={t(`expiryOption.${e}`)} />
        ))}
      </RadioList>
    </FormDialog>
  );
}
