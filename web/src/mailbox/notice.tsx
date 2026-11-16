import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getMessage, senderName } from "./api";

// The in-page notice for new mail while the page is in the foreground (docs/M5c-foreground.md).
// It names the sender and the subject, never the body. The toast viewport announces it politely
// and does not move focus.

/** At most this many notices are visible; a newer one replaces the oldest. */
const MAX_NOTICES = 3;

/** The page is in the foreground: visible and focused. The Hub hears the same over the socket. */
export function inForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useMailNotice(): (id: string) => Promise<void> {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const next = useRef(0);

  return useCallback(
    async (id: string) => {
      let message: Awaited<ReturnType<typeof getMessage>>["message"];
      try {
        ({ message } = await getMessage(id));
      } catch {
        // The list still shows the message; a missed notice needs no further handling.
        return;
      }
      // Notices take turns in MAX_NOTICES slots; the viewport replaces the one in the same slot,
      // which is the oldest.
      const slot = next.current++ % MAX_NOTICES;
      const dismiss = toast({
        body: t("notification.notice", {
          from: senderName(message.from) || t("notification.newMail"),
          subject: message.subject?.trim() || t("mail.noSubject"),
        }),
        uniqueID: `new-mail-${slot}`,
        endContent: (
          <Button
            label={t("notification.open")}
            variant="ghost"
            size="sm"
            onClick={() => {
              dismiss();
              void navigate({ to: "/", search: { m: id } as never });
            }}
          />
        ),
      });
    },
    [t, toast, navigate],
  );
}
