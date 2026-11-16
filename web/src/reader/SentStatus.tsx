import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import { retrySend } from "../compose/api";
import { errorMessage } from "../errors";
import type { MessageDetail } from "../mailbox/api";
import { SendStatusLabel } from "../mailbox/SendStatusLabel";

/** The Worker's retry limits (worker/src/send/send.ts). */
const SENDING_STALE_MS = 60_000;
const RETRY_WINDOW_MS = 24 * 3600_000 - 5 * 60_000;

/**
 * The status line of an open sent message, with Retry for a failed send and for one that stopped
 * mid-send, inside Resend's idempotency window from the first attempt. A delivery failure that
 * Resend reported and a rejection are final and offer no Retry. Past the window, a message whose
 * outcome is unknown can only be sent as a new message (owner ruling 13).
 */
export function SentStatus({
  message,
  onRetried,
  onSendAsNew,
}: {
  message: Pick<
    MessageDetail,
    "id" | "status" | "error" | "receivedAt" | "idempotencyKey" | "firstAttemptAt" | "maybeAccepted"
  >;
  onRetried: (status: string) => void;
  onSendAsNew: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The Worker answered that the window has passed, whatever this clock says.
  const [unknownFor, setUnknownFor] = useState<string | null>(null);
  if (message.status === "delivery_failed") {
    return (
      <Banner
        status="error"
        title={t("mail.sendStatus.delivery_failed")}
        description={t("mail.deliveryFailedHelp")}
      />
    );
  }
  const now = Date.now();
  const stalled = message.status === "sending" && now - message.receivedAt > SENDING_STALE_MS;
  const rejected = message.status === "failed" && message.error === "send_rejected";
  const outcomeUnknown =
    message.status === "sending" || (message.status === "failed" && message.maybeAccepted === 1);
  const pastWindow = now - (message.firstAttemptAt ?? message.receivedAt) >= RETRY_WINDOW_MS;
  if (unknownFor === message.id || (outcomeUnknown && !rejected && pastWindow)) {
    return (
      <Banner
        status="warning"
        title={t("mail.sendUnknown")}
        description={t("mail.sendUnknownHelp")}
        endContent={
          <Button label={t("mail.sendAsNew")} variant="secondary" size="sm" onClick={onSendAsNew} />
        }
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
      const code = err instanceof ApiError ? err.code : "network";
      if (code === "send_status_unknown") {
        setUnknownFor(message.id);
        return;
      }
      toast({ body: errorMessage(t, err), type: "error" });
      // Another attempt holds the row: its status is left as it is until that attempt ends.
      if (code !== "network" && code !== "send_in_progress") onRetried("failed");
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
        !rejected && (
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
