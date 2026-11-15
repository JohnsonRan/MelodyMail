import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FingerPrintIcon } from "@heroicons/react/24/outline";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api";
import { AuthFrame } from "../components/AuthFrame";
import { QrCode } from "../components/QrCode";
import { RecoveryKeyPanel } from "../components/RecoveryKeyPanel";
import { errorMessage } from "../errors";
import { groupInFours } from "../passkeys";

type SetupStart = {
  options: PublicKeyCredentialCreationOptionsJSON;
  totp: { secret: string; uri: string };
};

const STEPS = ["setup.stepToken", "setup.stepPasskey", "setup.stepTotp", "setup.stepRecovery"];

/** First-run setup, one screen per step: token, Passkey, authenticator app, recovery key. */
export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [token, setToken] = useState("");
  const [start, setStart] = useState<SetupStart | null>(null);
  const [credential, setCredential] = useState<RegistrationResponseJSON | null>(null);
  const [code, setCode] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One action at a time. onEnter fires on every keydown, key repeat included, and busy is
  // state that updates only after a render, so a ref is the guard.
  const inFlight = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === "already_initialized") {
        await navigate({ to: "/login" });
        return;
      }
      setError(errorMessage(t, err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitToken = () =>
    run(async () => {
      setStart(await api<SetupStart>("POST", "/auth/setup/options", { setupToken: token }));
      setStep(1);
    });

  const createPasskey = () =>
    run(async () => {
      if (!start) return;
      setCredential(await startRegistration({ optionsJSON: start.options }));
      setStep(2);
    });

  const finish = () =>
    run(async () => {
      const done = await api<{ recoveryKey: string }>("POST", "/auth/setup/verify", {
        setupToken: token,
        credential,
        totpCode: code.trim(),
        label: t("passkeyDefaultLabel"),
      });
      setRecoveryKey(done.recoveryKey);
      setStep(3);
    });

  const startOver = () => {
    setStep(0);
    setStart(null);
    setCredential(null);
    setCode("");
    setError(null);
  };

  return (
    <AuthFrame title={t("setup.title")}>
      <Stepper activeStep={step} label={t("setup.progress")}>
        {STEPS.map((key, index) => (
          <Step key={key} step={index} label={t(key)} />
        ))}
      </Stepper>
      {error && (
        <Banner
          status="error"
          title={error}
          endContent={
            step > 0 && step < 3 ? (
              <Button
                label={t("setup.startOver")}
                variant="secondary"
                size="sm"
                onClick={startOver}
              />
            ) : undefined
          }
        />
      )}

      {step === 0 && (
        <VStack gap={4} hAlign="stretch">
          <Text type="body" color="secondary">
            {t("setup.tokenDescription")}
          </Text>
          <TextInput
            label={t("setup.tokenLabel")}
            type="password"
            autoComplete="off"
            value={token}
            onChange={setToken}
            onEnter={() => void submitToken()}
            hasAutoFocus
          />
          <Button
            label={t("setup.continue")}
            variant="primary"
            size="lg"
            isLoading={busy}
            isDisabled={token.length === 0}
            onClick={() => void submitToken()}
          />
        </VStack>
      )}

      {step === 1 && (
        <VStack gap={4} hAlign="stretch">
          <Text type="body" color="secondary">
            {t("setup.passkeyDescription")}
          </Text>
          <Button
            label={t("setup.createPasskey")}
            variant="primary"
            size="lg"
            icon={<Icon icon={FingerPrintIcon} />}
            isLoading={busy}
            onClick={() => void createPasskey()}
          />
        </VStack>
      )}

      {step === 2 && start && (
        <VStack gap={4} hAlign="stretch">
          <Text type="body" color="secondary">
            {t("setup.totpDescription")}
          </Text>
          <VStack gap={2} hAlign="center">
            <QrCode value={start.totp.uri} label={t("setup.qrLabel")} />
            <Text type="supporting" color="secondary">
              {t("setup.totpSecretLabel")}
            </Text>
            <Code>{groupInFours(start.totp.secret)}</Code>
          </VStack>
          <TextInput
            label={t("setup.codeLabel")}
            value={code}
            onChange={setCode}
            onEnter={() => void finish()}
            inputMode="numeric"
            autoComplete="one-time-code"
            hasAutoFocus
          />
          <Button
            label={t("setup.finish")}
            variant="primary"
            size="lg"
            isLoading={busy}
            isDisabled={code.trim().length !== 6}
            onClick={() => void finish()}
          />
        </VStack>
      )}

      {step === 3 && (
        <RecoveryKeyPanel
          recoveryKey={recoveryKey}
          notice={t("recoveryKey.setupNotice")}
          continueLabel={t("recoveryKey.continue")}
          onContinue={() => void navigate({ to: "/" })}
        />
      )}
    </AuthFrame>
  );
}
