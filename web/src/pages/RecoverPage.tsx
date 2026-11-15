import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { FingerPrintIcon } from "@heroicons/react/24/outline";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { AuthFrame } from "../components/AuthFrame";
import { RecoveryKeyPanel } from "../components/RecoveryKeyPanel";
import { errorMessage } from "../errors";
import { addPasskey } from "../passkeys";

type Stage = "form" | "newKey" | "addPasskey";

/** Fallback sign-in: recovery key plus TOTP code, then a new key, then an offer to add a Passkey. */
export function RecoverPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("form");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [code, setCode] = useState("");
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  const recover = () =>
    run(async () => {
      const done = await api<{ recoveryKey: string }>("POST", "/auth/recover", {
        recoveryKey: recoveryKey.trim(),
        totpCode: code.trim(),
      });
      setNewKey(done.recoveryKey);
      setStage("newKey");
    });

  const registerPasskey = () =>
    run(async () => {
      await addPasskey(t("passkeyDefaultLabel"));
      toast({ body: t("security.passkeyAdded") });
      await navigate({ to: "/" });
    });

  const title =
    stage === "form"
      ? t("recover.title")
      : stage === "newKey"
        ? t("recover.newKeyTitle")
        : t("recover.addPasskeyTitle");

  return (
    <AuthFrame title={title} description={stage === "form" ? t("recover.description") : undefined}>
      {error && <Banner status="error" title={error} />}

      {stage === "form" && (
        <VStack gap={4} hAlign="stretch">
          <TextInput
            label={t("recover.keyLabel")}
            value={recoveryKey}
            onChange={setRecoveryKey}
            autoComplete="off"
            autoCapitalize="characters"
            hasAutoCorrect={false}
            hasSpellCheck={false}
            hasAutoFocus
          />
          <TextInput
            label={t("recover.codeLabel")}
            value={code}
            onChange={setCode}
            onEnter={() => void recover()}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          <Button
            label={t("recover.submit")}
            variant="primary"
            size="lg"
            isLoading={busy}
            isDisabled={recoveryKey.trim().length === 0 || code.trim().length !== 6}
            onClick={() => void recover()}
          />
          <VStack hAlign="center">
            <Link href="/login" type="supporting">
              {t("recover.backToLogin")}
            </Link>
          </VStack>
        </VStack>
      )}

      {stage === "newKey" && (
        <RecoveryKeyPanel
          recoveryKey={newKey}
          notice={t("recoveryKey.rotatedNotice")}
          continueLabel={t("recover.continue")}
          onContinue={() => setStage("addPasskey")}
        />
      )}

      {stage === "addPasskey" && (
        <VStack gap={4} hAlign="stretch">
          <Text type="body" color="secondary">
            {t("recover.addPasskeyDescription")}
          </Text>
          <Button
            label={t("recover.addPasskey")}
            variant="primary"
            size="lg"
            icon={<Icon icon={FingerPrintIcon} />}
            isLoading={busy}
            onClick={() => void registerPasskey()}
          />
          <Button
            label={t("recover.skip")}
            variant="ghost"
            size="lg"
            onClick={() => void navigate({ to: "/" })}
          />
        </VStack>
      )}
    </AuthFrame>
  );
}
