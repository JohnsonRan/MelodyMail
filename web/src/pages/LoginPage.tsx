import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { FingerPrintIcon } from "@heroicons/react/24/outline";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthFrame } from "../components/AuthFrame";
import { errorMessage } from "../errors";
import { signInWithPasskey } from "../passkeys";

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      await navigate({ to: "/" });
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={t("login.title")} description={t("login.description")}>
      {!supported && <Banner status="warning" title={t("errors.passkeyUnsupported")} />}
      {error && <Banner status="error" title={error} />}
      <Button
        label={t("login.signIn")}
        variant="primary"
        size="lg"
        icon={<Icon icon={FingerPrintIcon} />}
        isLoading={busy}
        isDisabled={!supported}
        onClick={() => void signIn()}
      />
      <VStack hAlign="center">
        <Link href="/recover" type="supporting">
          {t("login.recoverLink")}
        </Link>
      </VStack>
    </AuthFrame>
  );
}
