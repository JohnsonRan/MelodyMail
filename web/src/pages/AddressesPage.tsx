import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { AtSymbolIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { api } from "../api";
import { AddressDialog, type AddressDraft, draftOf } from "../components/AddressDialog";
import { DataTable, TableSkeleton, Value } from "../components/DataTable";
import { PageFrame } from "../components/PageFrame";
import { type Address, type Domain, type ForwardTarget, useSettingsPage } from "../settings";

type Data = { addresses: Address[]; domains: Domain[]; targets: ForwardTarget[] };

async function loadAll(): Promise<Data> {
  const [a, d, f] = await Promise.all([
    api<{ addresses: Address[] }>("GET", "/addresses"),
    api<{ domains: Domain[] }>("GET", "/domains"),
    api<{ targets: ForwardTarget[] }>("GET", "/forward-targets"),
  ]);
  return { addresses: a.addresses, domains: d.domains, targets: f.targets };
}

/** Settings > Addresses: the only addresses that receive mail, and where each forwards. */
export function AddressesPage() {
  const { data, loadError, busy, act, reload, toast, t } = useSettingsPage(loadAll);
  const [editing, setEditing] = useState<Address | null>(null);
  const [draft, setDraft] = useState<AddressDraft | null>(null);
  const [removing, setRemoving] = useState<Address | null>(null);

  const open = (address: Address | null) => {
    setEditing(address);
    setDraft(draftOf(address, data?.domains ?? []));
  };

  const fields = (d: AddressDraft) => ({
    note: d.note,
    displayName: d.displayName,
    enabled: d.enabled,
    forwardOnly: d.forwardOnly,
    targetIds: d.targetIds,
  });

  const onSave = () =>
    act("save", async () => {
      if (!draft) return;
      if (editing) {
        await api("PATCH", `/addresses/${editing.id}`, fields(draft));
        toast({ body: t("addresses.saved") });
      } else {
        await api("POST", "/addresses", {
          localPart: draft.localPart,
          domain: draft.domain,
          ...fields(draft),
        });
        toast({ body: t("addresses.added") });
      }
      setDraft(null);
      await reload();
    });

  const onToggle = (address: Address, enabled: boolean) =>
    act(`enabled:${address.id}`, async () => {
      await api("PATCH", `/addresses/${address.id}`, { enabled });
      await reload();
    });

  const onRemove = (address: Address) =>
    act("remove", async () => {
      await api("DELETE", `/addresses/${address.id}`);
      toast({ body: t("addresses.removed") });
      setRemoving(null);
      await reload();
    });

  const emailOf = (id: number) => data?.targets.find((x) => x.id === id)?.email ?? "";
  const noDomains = data !== null && data.domains.length === 0;
  // The title row keeps its button while loading, so nothing moves when the data arrives;
  // the empty state repeats the action as a secondary button.
  const addButton = (variant: "primary" | "secondary") => (
    <Button
      label={t("addresses.add")}
      variant={variant}
      isDisabled={!data || noDomains}
      onClick={() => open(null)}
    />
  );

  return (
    <PageFrame title={t("addresses.title")} actions={addButton("primary")}>
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}
      {!data && !loadError && <TableSkeleton />}
      {data && data.addresses.length === 0 && (
        <Center>
          <EmptyState
            icon={<Icon icon={AtSymbolIcon} size="lg" color="secondary" />}
            title={t("addresses.emptyTitle")}
            description={noDomains ? t("addresses.emptyNoDomain") : t("addresses.emptyDescription")}
            actions={
              noDomains ? (
                <Button label={t("domains.add")} variant="secondary" href="/settings/domains" />
              ) : (
                addButton("secondary")
              )
            }
          />
        </Center>
      )}
      {data && data.addresses.length > 0 && (
        <DataTable
          rows={data.addresses}
          actionsHeader={t("settingsPage.actions")}
          columns={[
            {
              key: "address",
              header: t("addresses.address"),
              render: (a) => (
                <VStack gap={0}>
                  <Value>{a.address}</Value>
                  {a.displayName && (
                    <Text type="supporting" color="secondary">
                      {a.displayName}
                    </Text>
                  )}
                </VStack>
              ),
            },
            {
              key: "enabled",
              header: t("addresses.receiving"),
              render: (a) => (
                <Switch
                  label={t("addresses.enabledFor", { address: a.address })}
                  isLabelHidden
                  value={a.enabled}
                  isLoading={busy === `enabled:${a.id}`}
                  onChange={(v) => void onToggle(a, v)}
                />
              ),
            },
            {
              key: "forwarding",
              header: t("addresses.forwarding"),
              render: (a) => (
                <VStack gap={0}>
                  {a.targetIds.length === 0 ? (
                    <Text color="secondary">{t("addresses.notForwarded")}</Text>
                  ) : (
                    a.targetIds.map((id) => <Value key={id}>{emailOf(id)}</Value>)
                  )}
                  {a.forwardOnly && (
                    <Text type="supporting" color="secondary">
                      {t("addresses.forwardOnlyShort")}
                    </Text>
                  )}
                </VStack>
              ),
            },
            { key: "note", header: t("settingsPage.note"), render: (a) => <Text>{a.note}</Text> },
          ]}
          actions={(a) => (
            <HStack gap={1} hAlign="end" wrap="wrap">
              <Button
                label={t("addresses.edit")}
                variant="ghost"
                size="sm"
                onClick={() => open(a)}
              />
              <Button
                label={t("settingsPage.delete")}
                variant="ghost"
                size="sm"
                onClick={() => setRemoving(a)}
              />
            </HStack>
          )}
        />
      )}

      <AddressDialog
        draft={draft}
        isNew={editing === null}
        domains={data?.domains ?? []}
        targets={data?.targets ?? []}
        isSubmitting={busy === "save"}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSubmit={() => void onSave()}
      />

      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(isOpen) => !isOpen && setRemoving(null)}
        title={t("addresses.removeTitle", { address: removing?.address ?? "" })}
        description={t("addresses.removeDescription")}
        actionLabel={t("settingsPage.delete")}
        cancelLabel={t("common.cancel")}
        isActionLoading={busy === "remove"}
        onAction={() => removing && void onRemove(removing)}
      />
    </PageFrame>
  );
}
