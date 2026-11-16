import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useTranslation } from "react-i18next";
import { FormDialog } from "../components/FormDialog";
import type { ForwardTarget } from "../settings";
import { ConditionRow } from "./ConditionRow";
import { RuleTestPanel } from "./RuleTestPanel";
import {
  ACTIONS,
  CONDITIONS_MAX,
  emptyDraft,
  newCondition,
  RULE_TARGETS_MAX,
  type RuleDraft,
} from "./types";

/** Create or edit a rule: name, all or any, conditions, actions, and a test against a message. */
export function RuleDialog({
  draft,
  isNew,
  targets,
  addresses,
  isSubmitting,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: RuleDraft | null;
  isNew: boolean;
  targets: ForwardTarget[];
  addresses: string[];
  isSubmitting: boolean;
  onChange: (draft: RuleDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation("rules");
  const d = draft ?? emptyDraft();
  const set = (patch: Partial<RuleDraft>) => onChange({ ...d, ...patch });
  const conditions = d.conditions;
  return (
    <FormDialog
      isOpen={draft !== null}
      onClose={onClose}
      title={isNew ? t("editor.createTitle") : t("editor.editTitle", { name: d.name })}
      submitLabel={isNew ? t("create") : t("editor.save")}
      isSubmitting={isSubmitting}
      onSubmit={onSubmit}
      width={720}
    >
      <TextInput
        label={t("editor.name")}
        value={d.name}
        onChange={(name) => set({ name })}
        hasAutoFocus
      />
      <RadioList
        label={t("editor.match")}
        orientation="horizontal"
        value={d.match}
        onChange={(match) => set({ match: match as RuleDraft["match"] })}
      >
        <RadioListItem value="all" label={t("editor.matchAll")} />
        <RadioListItem value="any" label={t("editor.matchAny")} />
      </RadioList>

      <VStack gap={2} hAlign="stretch">
        <Heading level={3}>{t("editor.conditions")}</Heading>
        {conditions.map((c, i) => (
          <ConditionRow
            // Rows have no identity of their own; the list only grows at the end or loses a row.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={i}
            index={i}
            condition={c}
            addresses={addresses}
            canRemove={conditions.length > 1}
            onChange={(next) => set({ conditions: conditions.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ conditions: conditions.filter((_, j) => j !== i) })}
          />
        ))}
        <Text type="supporting">{t("editor.domainHint")}</Text>
        <VStack hAlign="start">
          <Button
            label={t("editor.addCondition")}
            variant="secondary"
            size="sm"
            isDisabled={conditions.length >= CONDITIONS_MAX}
            onClick={() => set({ conditions: [...conditions, newCondition()] })}
          />
        </VStack>
      </VStack>

      <VStack gap={2} hAlign="stretch">
        <Heading level={3}>{t("editor.actions")}</Heading>
        {targets.length > 0 ? (
          <CheckboxList
            label={t("editor.forwardTo")}
            description={t("editor.forwardToDescription", { max: RULE_TARGETS_MAX })}
            value={d.targetIds.map(String)}
            onChange={(ids) => set({ targetIds: ids.map(Number).slice(0, RULE_TARGETS_MAX) })}
            isOptional
          >
            {targets.map((target) => (
              <CheckboxListItem key={target.id} value={String(target.id)} label={target.email} />
            ))}
          </CheckboxList>
        ) : (
          <Text type="supporting">
            {t("editor.noTargets")}{" "}
            <Link href="/settings/forwarding" type="supporting">
              {t("editor.manageTargets")}
            </Link>
          </Text>
        )}
        {ACTIONS.map((a) => (
          <CheckboxInput
            key={a}
            label={t(`action.${a}`)}
            description={a === "stop" ? t("editor.stopDescription") : undefined}
            value={d[a]}
            onChange={(checked) => set({ [a]: checked })}
          />
        ))}
      </VStack>

      {draft && <RuleTestPanel draft={draft} />}
    </FormDialog>
  );
}
