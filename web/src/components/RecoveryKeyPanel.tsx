import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Code } from "@astryxdesign/core/Code";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Shows a recovery key the one time the server returns it. The owner must confirm saving it
 * before moving on.
 */
export function RecoveryKeyPanel({
  recoveryKey,
  notice,
  continueLabel,
  onContinue,
}: {
  recoveryKey: string;
  notice: string;
  continueLabel: string;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const { copy, isCopied } = useClipboard({ announce: t("recoveryKey.copied") });
  return (
    <VStack gap={4} hAlign="stretch">
      <Banner status="warning" title={t("recoveryKey.shownOnce")} description={notice} />
      <Card padding={4} width="100%">
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Code>{recoveryKey.replaceAll("-", " ")}</Code>
          </StackItem>
          <Button
            label={isCopied ? t("recoveryKey.copied") : t("recoveryKey.copy")}
            variant="secondary"
            size="sm"
            icon={<Icon icon={isCopied ? CheckIcon : ClipboardDocumentIcon} />}
            onClick={() => void copy(recoveryKey)}
          />
        </HStack>
      </Card>
      <CheckboxInput label={t("recoveryKey.confirm")} value={saved} onChange={setSaved} />
      <Button
        label={continueLabel}
        variant="primary"
        size="lg"
        isDisabled={!saved}
        onClick={onContinue}
      />
    </VStack>
  );
}
