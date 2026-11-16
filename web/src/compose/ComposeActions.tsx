import { Button } from "@astryxdesign/core/Button";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useTranslation } from "react-i18next";
import type { SaveState } from "./useCompose";

/** Send, Save draft with the autosave state, and Discard. */
export function ComposeActions({
  onSend,
  sending,
  blocked,
  onSave,
  save,
  onDiscard,
}: {
  onSend: () => void;
  sending: boolean;
  /** Why Send cannot run now, or null. */
  blocked: string | null;
  onSave: () => void;
  save: SaveState;
  onDiscard: () => void;
}) {
  const { t } = useTranslation("compose");
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Button
        label={t("send")}
        variant="primary"
        tooltip={blocked ?? t("sendShortcut")}
        isLoading={sending}
        isDisabled={blocked !== null}
        onClick={onSend}
      />
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
