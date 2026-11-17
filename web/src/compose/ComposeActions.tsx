import { Button } from "@astryxdesign/core/Button";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SaveState } from "./useCompose";

/** Send, with the reason it cannot run yet as its tooltip. */
export function SendButton({
  onSend,
  sending,
  blocked,
}: {
  onSend: () => void;
  sending: boolean;
  /** Why Send cannot run now, or null. */
  blocked: string | null;
}) {
  const { t } = useTranslation("compose");
  return (
    <Button
      label={t("send")}
      variant="primary"
      tooltip={blocked || t("sendShortcut")}
      isLoading={sending}
      isDisabled={blocked !== null}
      onClick={onSend}
    />
  );
}

/** Save draft with the autosave state, and Discard; Send too unless the title row holds it. */
export function ComposeActions({
  send,
  onSave,
  save,
  onDiscard,
}: {
  /** The Send button, or null when the page's title row shows it. */
  send: ReactNode;
  onSave: () => void;
  save: SaveState;
  onDiscard: () => void;
}) {
  const { t } = useTranslation("compose");
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {send}
      <Button label={t("saveDraft")} variant="secondary" onClick={onSave} />
      <StackItem size="fill">
        {save !== "idle" && (
          <Text type="supporting" color={save === "error" ? "primary" : "secondary"}>
            {t(`saveState.${save}`)}
          </Text>
        )}
      </StackItem>
      <Button label={t("discard")} variant="ghost" onClick={onDiscard} />
    </HStack>
  );
}
