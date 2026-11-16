import i18next from "i18next";
import { getMessage, senderName } from "../mailbox/api";
import { notificationFor } from "./notification";
import { deviceSubscribed } from "./push";

/**
 * Shows the system notification for new mail while this page is open but hidden. The Hub sends
 * no push to a session that has a page connected, so without this a hidden page would leave this
 * device unnotified (docs/M4b-pwa.md, "Sending"). Hidden tabs share one tag, so one shows. The
 * caller skips it for an event the Hub marked quiet (docs/M5c-foreground.md).
 */
export async function notifyWhenHidden(id: string): Promise<void> {
  if (document.visibilityState !== "hidden" || !(await deviceSubscribed())) return;
  try {
    const [{ message }, registration] = await Promise.all([
      getMessage(id),
      navigator.serviceWorker.ready,
    ]);
    const { title, options } = notificationFor(
      {
        type: "message",
        id,
        from: senderName(message.from),
        subject: message.subject,
        to: message.envelopeTo,
      },
      {
        newMail: i18next.t("notification.newMail"),
        noSubject: i18next.t("mail.noSubject"),
        testBody: i18next.t("notification.testBody"),
      },
      i18next.t("app.name"),
    );
    await registration.showNotification(title, options);
  } catch {
    // The list still shows the message; a missed notification needs no further handling.
  }
}
