import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { type ToastType, useToast } from "@astryxdesign/core/Toast";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { EnvelopeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getMessage, senderName } from "./api";

// The in-page notice for new mail while the page is in the foreground (docs/M5c-foreground.md).
// It names the sender and the subject, never the body. A mail card on the page's surface, so it
// reads apart from the app's ordinary inverted toasts (owner ruling 2026-11-16). The toast
// viewport keeps its position, auto-hide, swipe and polite announcement and does not move focus.

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
      const from = senderName(message.from) || t("notification.newMail");
      const subject = message.subject?.trim() || t("mail.noSubject");
      // Notices take turns in MAX_NOTICES slots; the viewport replaces the one in the same slot,
      // which is the oldest.
      const slot = next.current++ % MAX_NOTICES;
      toast({
        // Required by useToast; with renderContent the viewport announces the card's own text.
        body: t("notification.notice", { from, subject }),
        uniqueID: `new-mail-${slot}`,
        // The theme's "mail" type paints the card (src/themes/melody/melodyTheme.ts). Toast's
        // type is a closed union and `theme build` emits no augmentation for it, hence the cast;
        // a custom type is not "error", so auto-hide is set here.
        type: "mail" as ToastType,
        isAutoHide: true,
        renderContent: ({ dismiss }) => (
          <HStack gap={3} vAlign="center">
            <Icon icon={EnvelopeIcon} color="secondary" />
            <StackItem size="fill">
              {/* The viewport announces the card's text; this names what it is. */}
              <VisuallyHidden>{t("notification.newMail")}</VisuallyHidden>
              <VStack gap={0.5}>
                <Text weight="bold" maxLines={1}>
                  {from}
                </Text>
                <Text type="supporting" maxLines={1}>
                  {subject}
                </Text>
              </VStack>
            </StackItem>
            {/* Static items keep their width; the text column shrinks instead. */}
            <StackItem>
              <HStack gap={1} vAlign="center">
                <Button
                  label={t("notification.open")}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    dismiss();
                    void navigate({ to: "/", search: { m: id } as never });
                  }}
                />
                <IconButton
                  label={t("notification.close")}
                  icon={<Icon icon={XMarkIcon} />}
                  variant="ghost"
                  size="sm"
                  onClick={dismiss}
                />
              </HStack>
            </StackItem>
          </HStack>
        ),
      });
    },
    [t, toast, navigate],
  );
}
