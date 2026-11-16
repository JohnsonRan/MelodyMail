import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import { retrySend } from "../compose/api";
import { errorMessage } from "../errors";
import type { MessageItem } from "../mailbox/api";
import { SendStatusLabel } from "../mailbox/SendStatusLabel";

/** The status line of an open sent message, with Retry for a failed send. */
export function SentStatus({
  message,
  onRetried,
}: {
  message: Pick<MessageItem, "status" | "error"> & { idempotencyKey: string | null };
  onRetried: (status: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (message.status !== "failed") {
    return <SendStatusLabel status={message.status} />;
  }
  const retry = async () => {
    if (!message.idempotencyKey || busy) return;
    setBusy(true);
    try {
      const { message: sent } = await retrySend(message.idempotencyKey);
      toast({ body: t("mail.retried") });
      onRetried(sent.status);
    } catch (err) {
      toast({ body: errorMessage(t, err), type: "error" });
      if (err instanceof ApiError && err.code !== "network") onRetried("failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      status="error"
      title={t("mail.sendStatus.failed")}
      description={errorMessage(t, new ApiError(message.error ?? "send_failed", 0))}
      endContent={
        message.idempotencyKey && (
          <Button
            label={t("mail.retrySend")}
            variant="secondary"
            size="sm"
            isLoading={busy}
            onClick={() => void retry()}
          />
        )
      }
    />
  );
}
