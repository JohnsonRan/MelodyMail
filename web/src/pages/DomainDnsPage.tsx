import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { DataTable, TableSkeleton, Value } from "../components/DataTable";
import { PageFrame } from "../components/PageFrame";
import { usePreferences } from "../preferences";
import { SELECTABLE } from "../selection";
import { useSettingsPage } from "../settings";

type Expected = { id: string; type: string; name: string | null; values: string[] | null };
type Guidance = { receive: Expected[]; send: Expected[] };
type Status = "found" | "missing" | "different";
type Checked = { id: string; status: Status; found: string[] };

const DOT = { found: "success", missing: "error", different: "warning" } as const;

/** Settings > Domains > DNS records: what to publish, and a check of what DNS holds now. */
export function DomainDnsPage() {
  const { name } = useParams({ from: "/shell/settings/domains/$name" });
  const { locale } = usePreferences();
  const path = `/domains/${encodeURIComponent(name)}`;
  const page = useSettingsPage(() => api<Guidance>("GET", `${path}/dns`));
  const { data, loadError, busy, act, toast, t } = page;
  const [check, setCheck] = useState<{ records: Checked[]; checkedAt: number } | null>(null);

  const onCheck = () =>
    act("check", async () => {
      setCheck(await api("POST", `${path}/dns/check`, {}));
      toast({ body: t("dns.checked") });
    });

  const statusOf = (id: string) => check?.records.find((r) => r.id === id);

  return (
    <PageFrame
      title={t("dns.title", { name })}
      actions={
        <>
          <Button label={t("dns.back")} variant="secondary" href="/settings/domains" />
          <Button
            label={t("dns.check")}
            variant="primary"
            isLoading={busy === "check"}
            isDisabled={!data}
            onClick={() => void onCheck()}
          />
        </>
      }
    >
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}

      <VStack gap={2}>
        <Heading level={2}>{t("dns.receiveTitle")}</Heading>
        <Text type="supporting" color="secondary">
          {t("dns.receiveDescription")}
        </Text>
        {check && (
          <Text type="supporting" color="secondary">
            {t("dns.checkedAt", {
              date: new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(
                check.checkedAt,
              ),
            })}
          </Text>
        )}
      </VStack>
      {data ? (
        <DataTable
          rows={data.receive}
          columns={[
            { key: "type", header: t("dns.type"), render: (r) => <Value>{r.type}</Value> },
            { key: "name", header: t("dns.name"), render: (r) => <Value>{r.name ?? ""}</Value> },
            {
              key: "value",
              header: t("dns.value"),
              render: (r) => (
                <VStack gap={0}>
                  {(r.values ?? []).map((v) => (
                    <Text key={v} style={SELECTABLE}>
                      {v}
                    </Text>
                  ))}
                  <Text type="supporting" color="secondary">
                    {t(`dns.hint.${r.id}`)}
                  </Text>
                </VStack>
              ),
            },
            {
              key: "status",
              header: t("dns.status"),
              render: (r) => {
                const s = statusOf(r.id);
                if (!s) return <Text color="secondary">{t("dns.notChecked")}</Text>;
                return (
                  <VStack gap={1}>
                    <HStack gap={2} vAlign="center">
                      <StatusDot variant={DOT[s.status]} label={t(`dns.status_${s.status}`)} />
                      <Text>{t(`dns.status_${s.status}`)}</Text>
                    </HStack>
                    {s.status === "different" &&
                      s.found.map((v) => (
                        <Text key={v} type="supporting" color="secondary" style={SELECTABLE}>
                          {v}
                        </Text>
                      ))}
                  </VStack>
                );
              },
            },
          ]}
        />
      ) : (
        !loadError && <TableSkeleton />
      )}

      <VStack gap={2}>
        <Heading level={2}>{t("dns.sendTitle")}</Heading>
        <Text type="supporting" color="secondary">
          {t("dns.sendDescription")}
        </Text>
      </VStack>
      {data ? (
        <DataTable
          rows={data.send}
          columns={[
            {
              key: "record",
              header: t("dns.record"),
              render: (r) => <Text>{t(`dns.send_${r.id}`)}</Text>,
            },
            { key: "type", header: t("dns.type"), render: (r) => <Value>{r.type}</Value> },
            {
              key: "value",
              header: t("dns.value"),
              render: () => <Text color="secondary">{t("dns.fromResend")}</Text>,
            },
          ]}
        />
      ) : (
        !loadError && <TableSkeleton />
      )}
    </PageFrame>
  );
}
