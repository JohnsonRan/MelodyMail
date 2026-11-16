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

/** The Worker's window for retrying a row still "sending" (worker/src/send/send.ts). */
const SENDING_STALE_MS = 60_000;
const SENDING_RETRY_MAX_MS = 24 * 3600_000;

/**
 * The status line of an open sent message, with Retry for a failed send and for one that stopped
 * mid-send within Resend's 24-hour idempotency window. A delivery failure that Resend reported and
 * a rejection are final and offer no Retry; so is a send unfinished after 24 hours, whose outcome
 * only Resend knows.
 */
export function SentStatus({
  message,
  onRetried,
}: {
  message: Pick<MessageItem, "status" | "error" | "receivedAt"> & { idempotencyKey: string | null };
  onRetried: (status: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (message.status === "delivery_failed") {
    return (
      <Banner
        status="error"
        title={t("mail.sendStatus.delivery_failed")}
        description={t("mail.deliveryFailedHelp")}
      />
    );
  }
  const age = Date.now() - message.receivedAt;
  const stalled = message.status === "sending" && age > SENDING_STALE_MS;
  if (stalled && age >= SENDING_RETRY_MAX_MS) {
    return (
      <Banner
        status="warning"
        title={t("mail.sendUnknown")}
        description={t("mail.sendUnknownHelp")}
      />
    );
  }
  if (message.status !== "failed" && !stalled) {
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
      status={stalled ? "warning" : "error"}
      title={stalled ? t("mail.sendStalled") : t("mail.sendStatus.failed")}
      description={
        stalled
          ? t("mail.sendStalledHelp")
          : errorMessage(t, new ApiError(message.error ?? "send_failed", 0))
      }
      endContent={
        // A rejection is final: the corrected message is a new send, from compose.
        message.idempotencyKey &&
        message.error !== "send_rejected" && (
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
