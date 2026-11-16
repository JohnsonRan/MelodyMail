import { Banner } from "@astryxdesign/core/Banner";
import { Switch } from "@astryxdesign/core/Switch";
import { api } from "../api";
import { useSettingsPage } from "../settings";
import { RowsSkeleton, SecuritySection } from "./SecuritySection";

/** GET and PUT /api/settings/quiet (worker/src/mail/quiet.ts). */
type QuietState = { quietForeground: boolean };

const loadQuiet = () => api<QuietState>("GET", "/settings/quiet");

/**
 * Settings > Notifications > While MelodyMail is open (docs/M5c-foreground.md, "Owner ruling: a
 * switch, default off"). The in-page notice always shows; the switch only decides whether push and
 * Telegram hold back while a page is in the foreground. It applies to every device at once.
 */
export function QuietSection() {
  const { data, setData, loadError, busy, act, toast, t } = useSettingsPage(loadQuiet);

  const onSwitch = (on: boolean) =>
    act("quiet", async () => {
      setData(await api<QuietState>("PUT", "/settings/quiet", { quietForeground: on }));
      toast({ body: t("notifications.quiet.saved") });
    });

  return (
    <SecuritySection
      title={t("notifications.quiet.sectionTitle")}
      description={t("notifications.quiet.description")}
    >
      {!data && !loadError && <RowsSkeleton />}
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}
      {data && (
        <Switch
          label={t("notifications.quiet.switch")}
          description={t("notifications.quiet.switchDescription")}
          value={data.quietForeground}
          isLoading={busy === "quiet"}
          onChange={(on) => void onSwitch(on)}
        />
      )}
    </SecuritySection>
  );
}
