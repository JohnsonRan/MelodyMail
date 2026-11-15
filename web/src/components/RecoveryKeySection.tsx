import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/Layout";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { withReauth } from "../passkeys";
import { RecoveryKeyPanel } from "./RecoveryKeyPanel";
import { SecuritySection } from "./SecuritySection";

/**
 * Settings > Security > Recovery key: regenerate after a confirmation, then show the new key
 * once in a dialog that stays open until the owner confirms saving it.
 */
export function RecoveryKeySection({ onError }: { onError: (err: unknown) => Promise<void> }) {
  const { t } = useTranslation();
  const [isConfirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const regenerate = async () => {
    setBusy(true);
    try {
      const done = await withReauth(() =>
        api<{ recoveryKey: string }>("POST", "/auth/recovery-key", {}),
      );
      setConfirming(false);
      setNewKey(done.recoveryKey);
    } catch (err) {
      await onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SecuritySection
      title={t("security.recoveryKey")}
      description={t("security.recoveryKeyDescription")}
    >
      <HStack>
        <Button
          label={t("security.regenerateKey")}
          variant="secondary"
          onClick={() => setConfirming(true)}
        />
      </HStack>

      <AlertDialog
        isOpen={isConfirming}
        onOpenChange={setConfirming}
        title={t("security.regenerateKeyTitle")}
        description={t("security.regenerateKeyDescription")}
        actionLabel={t("security.regenerateKey")}
        cancelLabel={t("security.cancel")}
        isActionLoading={busy}
        onAction={() => void regenerate()}
      />

      <Dialog isOpen={newKey !== null} onOpenChange={() => {}} purpose="required" padding={6}>
        <DialogHeader title={t("recover.newKeyTitle")} />
        {newKey && (
          <RecoveryKeyPanel
            recoveryKey={newKey}
            notice={t("recoveryKey.rotatedNotice")}
            continueLabel={t("security.recoveryKeySaved")}
            onContinue={() => setNewKey(null)}
          />
        )}
      </Dialog>
    </SecuritySection>
  );
}
