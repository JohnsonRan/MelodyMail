import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { api } from "../api";
import { DataTable, TableSkeleton, Value } from "../components/DataTable";
import { FormDialog } from "../components/FormDialog";
import { PageFrame } from "../components/PageFrame";
import { SendingQuota } from "../components/SendingQuota";
import { withReauth } from "../passkeys";
import { type Domain, useSettingsPage } from "../settings";

const path = (name: string) => `/domains/${encodeURIComponent(name)}`;

/** Settings > Domains: the domains that receive mail, their switches and DNS guidance. */
export function DomainsPage() {
  const page = useSettingsPage(
    async () => (await api<{ domains: Domain[] }>("GET", "/domains")).domains,
  );
  const { data, loadError, busy, act, reload, toast, t } = page;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<Domain | null>(null);

  const onAdd = () =>
    act("add", async () => {
      await api("POST", "/domains", { name });
      toast({ body: t("domains.added") });
      setAdding(false);
      setName("");
      await reload();
    });

  const onSwitch = (domain: Domain, field: "receiveEnabled" | "sendEnabled", value: boolean) =>
    act(`${field}:${domain.name}`, async () => {
      await api("PATCH", path(domain.name), { [field]: value });
      await reload();
    });

  const onRemove = (domain: Domain) =>
    act("remove", async () => {
      const force = domain.addressCount > 0 ? "?deleteAddresses=1" : "";
      // Deleting the addresses as well needs a recent Passkey; withReauth asks and retries.
      await withReauth(() => api("DELETE", `${path(domain.name)}${force}`));
      toast({ body: t("domains.removed") });
      setRemoving(null);
      await reload();
    });

  // The title row keeps its button while loading, so nothing moves when the data arrives;
  // the empty state repeats the action as a secondary button.
  const addButton = (variant: "primary" | "secondary") => (
    <Button
      label={t("domains.add")}
      variant={variant}
      isDisabled={!data}
      onClick={() => setAdding(true)}
    />
  );

  return (
    <PageFrame title={t("domains.title")} actions={addButton("primary")}>
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}
      {!data && !loadError && <TableSkeleton />}
      {data && data.length === 0 && (
        <Center>
          <EmptyState
            icon={<Icon icon={GlobeAltIcon} size="lg" color="secondary" />}
            title={t("domains.emptyTitle")}
            description={t("domains.emptyDescription")}
            actions={addButton("secondary")}
          />
        </Center>
      )}
      {data && data.length > 0 && (
        <DataTable
          rows={data.map((d) => ({ ...d, id: d.name }))}
          actionsHeader={t("settingsPage.actions")}
          columns={[
            { key: "name", header: t("domains.name"), render: (d) => <Value>{d.name}</Value> },
            {
              key: "receive",
              header: t("domains.receive"),
              render: (d) => (
                <Switch
                  label={t("domains.receiveFor", { name: d.name })}
                  isLabelHidden
                  value={d.receiveEnabled}
                  isLoading={busy === `receiveEnabled:${d.name}`}
                  onChange={(v) => void onSwitch(d, "receiveEnabled", v)}
                />
              ),
            },
            {
              key: "send",
              header: t("domains.send"),
              render: (d) => (
                <Switch
                  label={t("domains.sendFor", { name: d.name })}
                  isLabelHidden
                  value={d.sendEnabled}
                  isLoading={busy === `sendEnabled:${d.name}`}
                  onChange={(v) => void onSwitch(d, "sendEnabled", v)}
                />
              ),
            },
            {
              key: "addresses",
              header: t("domains.addresses"),
              render: (d) => <Text hasTabularNumbers>{d.addressCount}</Text>,
            },
          ]}
          actions={(d) => (
            <HStack gap={1} hAlign="end" wrap="wrap">
              <Button
                label={t("domains.dnsRecords")}
                variant="ghost"
                size="sm"
                href={`/settings/domains/${encodeURIComponent(d.name)}`}
              />
              <Button
                label={t("settingsPage.remove")}
                variant="ghost"
                size="sm"
                onClick={() => setRemoving(d)}
              />
            </HStack>
          )}
        />
      )}

      <FormDialog
        isOpen={adding}
        onClose={() => setAdding(false)}
        title={t("domains.addTitle")}
        submitLabel={t("domains.add")}
        isSubmitting={busy === "add"}
        onSubmit={() => void onAdd()}
      >
        <TextInput
          label={t("domains.name")}
          description={t("domains.nameDescription")}
          value={name}
          onChange={setName}
          onEnter={() => void onAdd()}
          placeholder="example.com"
          autoCapitalize="none"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          hasAutoFocus
        />
      </FormDialog>

      {data?.some((d) => d.sendEnabled) && <SendingQuota />}

      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("domains.removeTitle", { name: removing?.name ?? "" })}
        description={
          removing && removing.addressCount > 0
            ? t("domains.removeWithAddresses", { count: removing.addressCount })
            : t("domains.removeDescription")
        }
        actionLabel={t("settingsPage.remove")}
        cancelLabel={t("common.cancel")}
        isActionLoading={busy === "remove"}
        onAction={() => removing && void onRemove(removing)}
      />
    </PageFrame>
  );
}
