import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { type Condition, FIELDS, type Field, OPS, type Op } from "./types";

/**
 * One condition: field, operator, header name for the header field, value. The recipient field
 * offers the owner's addresses (docs/M6-rules-api.md, "Conditions"). Labels are hidden visually
 * and numbered, so a screen reader tells the rows apart.
 */
export function ConditionRow({
  index,
  condition,
  addresses,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  condition: Condition;
  addresses: string[];
  canRemove: boolean;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("rules");
  const n = index + 1;
  const set = (patch: Partial<Condition>) => onChange({ ...condition, ...patch });
  const setField = (field: Field) =>
    onChange({
      field,
      op: condition.op,
      value: field === "recipient" ? (addresses[0] ?? "") : condition.value,
      ...(field === "header" ? { name: condition.name ?? "" } : {}),
    });
  return (
    <HStack gap={2} vAlign="end" wrap="wrap">
      <Selector
        label={t("editor.fieldLabel", { n })}
        isLabelHidden
        options={FIELDS.map((f) => ({ value: f, label: t(`field.${f}`) }))}
        value={condition.field}
        onChange={(v) => setField(v as Field)}
      />
      {condition.field === "header" && (
        <TextInput
          label={t("editor.headerLabel", { n })}
          isLabelHidden
          placeholder={t("editor.headerPlaceholder")}
          value={condition.name ?? ""}
          onChange={(name) => set({ name })}
          autoCapitalize="none"
          hasAutoCorrect={false}
          hasSpellCheck={false}
        />
      )}
      <Selector
        label={t("editor.opLabel", { n })}
        isLabelHidden
        options={OPS.map((o) => ({ value: o, label: t(`op.${o}`) }))}
        value={condition.op}
        onChange={(v) => set({ op: v as Op })}
      />
      {condition.field === "recipient" && addresses.length > 0 ? (
        <Selector
          label={t("editor.valueLabel", { n })}
          isLabelHidden
          options={addresses}
          value={condition.value}
          onChange={(value) => set({ value })}
        />
      ) : (
        <TextInput
          label={t("editor.valueLabel", { n })}
          isLabelHidden
          placeholder={t("editor.valuePlaceholder")}
          value={condition.value}
          onChange={(value) => set({ value })}
          autoCapitalize="none"
          hasAutoCorrect={false}
          hasSpellCheck={false}
        />
      )}
      <IconButton
        label={t("editor.removeCondition", { n })}
        tooltip={t("editor.removeCondition", { n })}
        icon={<Icon icon={XMarkIcon} />}
        variant="ghost"
        isDisabled={!canRemove}
        onClick={onRemove}
      />
    </HStack>
  );
}
