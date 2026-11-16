import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/Layout";
import { Switch } from "@astryxdesign/core/Switch";
import { api } from "../api";
import { PageFrame } from "../components/PageFrame";
import { QuietSection } from "../components/QuietSection";
import { RowsSkeleton, SecuritySection } from "../components/SecuritySection";
import { TelegramSection } from "../components/TelegramSection";
import { readPushState, turnOff, turnOn } from "../pwa/push";
import { useSettingsPage } from "../settings";

/**
 * Settings > Notifications: Web Push for new mail on this device. Follows Gmail's desktop
 * notification setting (https://support.google.com/mail/answer/1075549): off until the owner
 * turns it on, and the browser's permission prompt appears only after that click. Telegram is a
 * second delivery channel on the same page, as GitHub lists every channel under Notifications.
 * "While MelodyMail is open" sits between them: it holds both back while a page is in front.
 */
export function NotificationsPage() {
  const { data: state, setData, loadError, busy, act, toast, t } = useSettingsPage(readPushState);

  const onSwitch = (on: boolean) =>
    act("switch", async () => {
      if (state?.kind !== "on" && state?.kind !== "off") return;
      const next = on ? await turnOn(state.key) : await turnOff(state.key);
      setData(next);
      if (next.kind === "on") toast({ body: t("notifications.turnedOn") });
      if (next.kind === "off" && !on) toast({ body: t("notifications.turnedOff") });
    });

  const onTest = () =>
    act("test", async () => {
      await api("POST", "/push/test", {});
      toast({ body: t("notifications.testSent") });
    });

  return (
    <PageFrame title={t("notifications.title")}>
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}
      <SecuritySection
        title={t("notifications.sectionTitle")}
        description={t("notifications.description")}
      >
        {!state && !loadError && <RowsSkeleton />}
        {state?.kind === "unsupported" && (
          <Banner
            status="info"
            title={t(`notifications.unsupported.${state.reason}.title`)}
            description={t(`notifications.unsupported.${state.reason}.description`)}
          />
        )}
        {state?.kind === "notConfigured" && (
          <Banner
            status="info"
            title={t("notifications.notSetUpTitle")}
            description={t("notifications.notSetUpDescription")}
          />
        )}
        {state?.kind === "blocked" && (
          <Banner
            status="warning"
            title={t("notifications.blockedTitle")}
            description={t("notifications.blockedDescription")}
          />
        )}
        {(state?.kind === "on" || state?.kind === "off") && (
          <>
            <Switch
              label={t("notifications.switch")}
              description={
                state.kind === "on" ? t("notifications.stateOn") : t("notifications.stateOff")
              }
              value={state.kind === "on"}
              isLoading={busy === "switch"}
              onChange={(on) => void onSwitch(on)}
            />
            <HStack>
              <Button
                label={t("notifications.sendTest")}
                variant="secondary"
                isDisabled={state.kind !== "on"}
                isLoading={busy === "test"}
                onClick={() => void onTest()}
              />
            </HStack>
          </>
        )}
      </SecuritySection>
      <Divider />
      <QuietSection />
      <Divider />
      <TelegramSection />
    </PageFrame>
  );
}
