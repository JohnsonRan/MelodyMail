import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { api } from "../api";
import { withReauth } from "../passkeys";
import { usePreferences } from "../preferences";
import { useSettingsPage } from "../settings";
import { RowsSkeleton, SecuritySection } from "./SecuritySection";

/** GET /api/telegram (worker/src/telegram/routes.ts). */
export type TelegramState =
  | { state: "notConfigured" | "httpsRequired" | "off" }
  | { state: "pending"; expiresAt: number }
  | { state: "on"; chatLabel: string | null; boundAt: number; lastError: string | null };

/** What Connect returns; the code is shown only from this answer, the server keeps its hash. */
type DeepLink = { url: string; code: string; expiresAt: number };

const POLL_MS = 3000;
const REASONS = new Set(["blocked", "rate_limited", "failed"]);

const loadState = () => api<TelegramState>("GET", "/telegram");

/**
 * Settings > Notifications > Telegram (docs/M5b-telegram.md, "Settings screen"). Connect hands out
 * a t.me deep link; the page asks for the state every 3 seconds until the chat is bound or the
 * code expires (at most 10 minutes).
 */
export function TelegramSection() {
  const { data, setData, loadError, busy, act, toast, t } = useSettingsPage(loadState);
  const { locale } = usePreferences();
  const [link, setLink] = useState<DeepLink | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { copy, isCopied } = useClipboard({ announce: t("notifications.telegram.copied") });
  const pending = data?.state === "pending";
  const expiresAt = data?.state === "pending" ? data.expiresAt : null;

  useEffect(() => {
    if (!pending || expiresAt === null) return;
    const timer = setInterval(async () => {
      if (Date.now() >= expiresAt) {
        setLink(null);
        setData({ state: "off" });
        toast({ body: t("notifications.telegram.expired") });
        return;
      }
      try {
        const next = await loadState();
        if (next.state === "pending") return;
        setLink(null);
        setData(next);
        if (next.state === "on") toast({ body: t("notifications.telegram.connected") });
      } catch {
        // The next tick asks again; the code's expiry ends the polling.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, expiresAt, setData, toast, t]);

  const time = (ms: number) => new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(ms);
  const date = (ms: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(ms);

  const onConnect = () =>
    act("connect", async () => {
      const next = await withReauth(() => api<DeepLink>("POST", "/telegram/link", {}));
      setLink(next);
      setData({ state: "pending", expiresAt: next.expiresAt });
    });

  const onCancel = () =>
    act("cancel", async () => {
      await api("DELETE", "/telegram/link");
      setLink(null);
      setData({ state: "off" });
    });

  const onTest = () =>
    act("test", async () => {
      try {
        await api("POST", "/telegram/test", {});
        toast({ body: t("notifications.telegram.testSent") });
      } finally {
        setData(await loadState());
      }
    });

  const onDisconnect = () =>
    act("disconnect", async () => {
      await api("DELETE", "/telegram");
      setConfirming(false);
      setData({ state: "off" });
      toast({ body: t("notifications.telegram.disconnected") });
    });

  const command = link ? `/start ${link.code}` : "";

  return (
    <SecuritySection
      title={t("notifications.telegram.sectionTitle")}
      description={t("notifications.telegram.description")}
    >
      {!data && !loadError && <RowsSkeleton />}
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}
      {data?.state === "notConfigured" && (
        <Banner
          status="info"
          title={t("notifications.telegram.notSetUpTitle")}
          description={t("notifications.telegram.notSetUpDescription")}
        />
      )}
      {data?.state === "httpsRequired" && (
        <Banner
          status="info"
          title={t("notifications.telegram.httpsTitle")}
          description={t("notifications.telegram.httpsDescription")}
        />
      )}
      {data?.state === "off" && (
        <HStack>
          <Button
            label={t("notifications.telegram.connect")}
            variant="primary"
            isLoading={busy === "connect"}
            onClick={() => void onConnect()}
          />
        </HStack>
      )}
      {data?.state === "pending" && link && (
        <Card padding={4} width="100%">
          <VStack gap={3} hAlign="start" data-telegram-pending>
            <Link href={link.url} isExternalLink isStandalone>
              {t("notifications.telegram.openTelegram")}
            </Link>
            <Text type="supporting" color="secondary">
              {t("notifications.telegram.orSend")}
            </Text>
            <Code>{command}</Code>
            <Button
              label={
                isCopied ? t("notifications.telegram.copied") : t("notifications.telegram.copy")
              }
              variant="secondary"
              size="sm"
              icon={<Icon icon={isCopied ? CheckIcon : ClipboardDocumentIcon} />}
              onClick={() => void copy(command)}
            />
            <Text type="supporting" color="secondary">
              {t("notifications.telegram.expires", { time: time(link.expiresAt) })}
            </Text>
          </VStack>
        </Card>
      )}
      {data?.state === "pending" && !link && (
        <Text type="supporting" color="secondary">
          {t("notifications.telegram.codeHidden")}
        </Text>
      )}
      {data?.state === "pending" && (
        <HStack gap={2} wrap="wrap">
          {!link && (
            <Button
              label={t("notifications.telegram.newCode")}
              variant="primary"
              isLoading={busy === "connect"}
              onClick={() => void onConnect()}
            />
          )}
          <Button
            label={t("notifications.telegram.cancel")}
            variant="secondary"
            isLoading={busy === "cancel"}
            onClick={() => void onCancel()}
          />
        </HStack>
      )}
      {data?.state === "on" && (
        <>
          <Text>
            {t("notifications.telegram.connectedTo", {
              label: data.chatLabel ?? "Telegram",
              date: date(data.boundAt),
            })}
          </Text>
          {data.lastError && (
            <Banner
              status="warning"
              title={t("notifications.telegram.lastErrorTitle")}
              description={t("notifications.telegram.lastErrorDescription", {
                reason: t(
                  `notifications.telegram.reason.${REASONS.has(data.lastError) ? data.lastError : "failed"}`,
                ),
              })}
            />
          )}
          <HStack gap={2} wrap="wrap">
            <Button
              label={t("notifications.telegram.sendTest")}
              variant="secondary"
              isLoading={busy === "test"}
              onClick={() => void onTest()}
            />
            <Button
              label={t("notifications.telegram.disconnect")}
              variant="secondary"
              onClick={() => setConfirming(true)}
            />
          </HStack>
        </>
      )}
      <AlertDialog
        isOpen={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={t("notifications.telegram.disconnectTitle")}
        description={t("notifications.telegram.disconnectDescription")}
        actionLabel={t("notifications.telegram.disconnect")}
        cancelLabel={t("notifications.telegram.cancel")}
        isActionLoading={busy === "disconnect"}
        onAction={() => void onDisconnect()}
      />
    </SecuritySection>
  );
}
