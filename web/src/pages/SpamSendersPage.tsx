import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { NoSymbolIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { DataTable, TableSkeleton, Value } from "../components/DataTable";
import { PageFrame } from "../components/PageFrame";
import { formatFullDate } from "../mailbox/format";
import { useSettingsPage } from "../settings";

type Sender = { address: string; createdAt: number };

/**
 * Settings > Spam senders: the senders Report spam remembered, whose later mail is filed into
 * Spam. Remove undoes a wrong entry, for example a forged From, without finding a message; mail
 * already in Spam stays there (docs/M8-mailbox-ux.md, "Filing").
 */
export function SpamSendersPage() {
  const page = useSettingsPage(
    async () => (await api<{ senders: Sender[] }>("GET", "/spam-senders")).senders,
  );
  const { data, loadError, busy, act, reload, toast, t } = page;
  const { i18n } = useTranslation();

  const onRemove = (sender: Sender) =>
    act(`remove:${sender.address}`, async () => {
      await api("DELETE", "/spam-senders", { address: sender.address });
      toast({ body: t("spamSenders.removed") });
      await reload();
    });

  return (
    <PageFrame title={t("spamSenders.title")}>
      <Text type="supporting" color="secondary">
        {t("spamSenders.description")}
      </Text>
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}
      {!data && !loadError && <TableSkeleton />}
      {data && data.length === 0 && (
        <Center>
          <EmptyState
            icon={<Icon icon={NoSymbolIcon} size="lg" color="secondary" />}
            title={t("spamSenders.emptyTitle")}
            description={t("spamSenders.emptyDescription")}
          />
        </Center>
      )}
      {data && data.length > 0 && (
        <DataTable
          rows={data.map((s) => ({ ...s, id: s.address }))}
          actionsHeader={t("settingsPage.actions")}
          columns={[
            {
              key: "address",
              header: t("spamSenders.address"),
              render: (s) => <Value>{s.address}</Value>,
            },
            {
              key: "added",
              header: t("spamSenders.added"),
              render: (s) => (
                <Text textWrap="nowrap" hasTabularNumbers>
                  {formatFullDate(s.createdAt, i18n.language)}
                </Text>
              ),
            },
          ]}
          actions={(s) => (
            <Button
              label={t("settingsPage.remove")}
              variant="ghost"
              size="sm"
              isLoading={busy === `remove:${s.address}`}
              onClick={() => void onRemove(s)}
            />
          )}
        />
      )}
    </PageFrame>
  );
}
