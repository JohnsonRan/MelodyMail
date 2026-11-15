import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { HStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useTranslation } from "react-i18next";
import type { Address, Domain, ForwardTarget } from "../settings";
import { FormDialog } from "./FormDialog";

export type AddressDraft = {
  localPart: string;
  domain: string;
  note: string;
  displayName: string;
  enabled: boolean;
  forwardOnly: boolean;
  targetIds: number[];
};

export function draftOf(address: Address | null, domains: Domain[]): AddressDraft {
  return address
    ? { ...address }
    : {
        localPart: "",
        domain: domains[0]?.name ?? "",
        note: "",
        displayName: "",
        enabled: true,
        forwardOnly: false,
        targetIds: [],
      };
}

/** Add or edit an address. Prefix and domain are fixed once the address exists. */
export function AddressDialog({
  draft,
  isNew,
  domains,
  targets,
  isSubmitting,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: AddressDraft | null;
  isNew: boolean;
  domains: Domain[];
  targets: ForwardTarget[];
  isSubmitting: boolean;
  onChange: (draft: AddressDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const d = draft ?? draftOf(null, domains);
  const set = (patch: Partial<AddressDraft>) => onChange({ ...d, ...patch });
  return (
    <FormDialog
      isOpen={draft !== null}
      onClose={onClose}
      title={
        isNew
          ? t("addresses.addTitle")
          : t("addresses.editTitle", { address: `${d.localPart}@${d.domain}` })
      }
      submitLabel={isNew ? t("addresses.add") : t("addresses.save")}
      isSubmitting={isSubmitting}
      onSubmit={onSubmit}
    >
      {isNew && (
        <HStack gap={2} vAlign="end" wrap="wrap">
          <TextInput
            label={t("addresses.localPart")}
            description={t("addresses.localPartDescription")}
            value={d.localPart}
            onChange={(localPart) => set({ localPart })}
            autoCapitalize="none"
            hasAutoCorrect={false}
            hasSpellCheck={false}
            hasAutoFocus
          />
          <Selector
            label={t("addresses.domain")}
            options={domains.map((x) => x.name)}
            value={d.domain}
            onChange={(domain) => set({ domain })}
          />
        </HStack>
      )}
      <TextInput
        label={t("addresses.displayName")}
        description={t("addresses.displayNameDescription")}
        value={d.displayName}
        onChange={(displayName) => set({ displayName })}
        isOptional
      />
      <TextInput
        label={t("settingsPage.note")}
        value={d.note}
        onChange={(note) => set({ note })}
        isOptional
      />
      <Switch
        label={t("addresses.enabled")}
        description={t("addresses.enabledDescription")}
        value={d.enabled}
        onChange={(enabled) => set({ enabled })}
      />
      {targets.length > 0 ? (
        <CheckboxList
          label={t("addresses.targets")}
          description={t("addresses.targetsDescription")}
          value={d.targetIds.map(String)}
          onChange={(ids) => {
            const targetIds = ids.map(Number);
            set({ targetIds, forwardOnly: targetIds.length > 0 && d.forwardOnly });
          }}
          isOptional
        >
          {targets.map((target) => (
            <CheckboxListItem key={target.id} value={String(target.id)} label={target.email} />
          ))}
        </CheckboxList>
      ) : (
        <Text type="supporting" color="secondary">
          {t("addresses.noTargets")}{" "}
          <Link href="/settings/forwarding" type="supporting">
            {t("addresses.manageTargets")}
          </Link>
        </Text>
      )}
      <Switch
        label={t("addresses.forwardOnly")}
        description={t("addresses.forwardOnlyDescription")}
        value={d.forwardOnly}
        isDisabled={d.targetIds.length === 0}
        onChange={(forwardOnly) => set({ forwardOnly })}
      />
    </FormDialog>
  );
}
