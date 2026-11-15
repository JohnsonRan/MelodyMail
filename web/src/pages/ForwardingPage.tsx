import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowUturnRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { api } from "../api";
import { DataTable, TableSkeleton, Value } from "../components/DataTable";
import { FormDialog } from "../components/FormDialog";
import { PageFrame } from "../components/PageFrame";
import { type Address, type ForwardTarget, useSettingsPage } from "../settings";

/** Settings > Forwarding: the addresses mail can be forwarded to. */
export function ForwardingPage() {
  const page = useSettingsPage(async () => {
    const [f, a] = await Promise.all([
      api<{ targets: ForwardTarget[] }>("GET", "/forward-targets"),
      api<{ addresses: Address[] }>("GET", "/addresses"),
    ]);
    return { targets: f.targets, addresses: a.addresses };
  });
  const { loadError, busy, act, reload, toast, t } = page;
  const data = page.data?.targets ?? null;
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [removing, setRemoving] = useState<ForwardTarget | null>(null);

  const onAdd = () =>
    act("add", async () => {
      await api("POST", "/forward-targets", { email, note });
      toast({ body: t("forwarding.added") });
      setAdding(false);
      setEmail("");
      setNote("");
      await reload();
    });

  // The confirmation names every address the target is removed from, and the forward-only ones
  // that go back to keeping a copy because it was their last target (owner ruling 2026-11-16).
  const removeDescription = (target: ForwardTarget) => {
    const using = (page.data?.addresses ?? []).filter((a) => a.targetIds.includes(target.id));
    if (using.length === 0) return t("forwarding.removeDescription");
    const switching = using.filter((a) => a.forwardOnly && a.targetIds.length === 1);
    const list = (xs: Address[]) => xs.map((a) => a.address).join(", ");
    const parts = [t("forwarding.removeInUse", { addresses: list(using) })];
    if (switching.length > 0) {
      parts.push(t("forwarding.switchesToStore", { addresses: list(switching) }));
    }
    return parts.join(" ");
  };

  const onRemove = (target: ForwardTarget) =>
    act("remove", async () => {
      const detach = target.addressCount > 0 ? "?detach=1" : "";
      await api("DELETE", `/forward-targets/${target.id}${detach}`);
      toast({ body: t("forwarding.removed") });
      setRemoving(null);
      await reload();
    });

  // The title row keeps its button while loading, so nothing moves when the data arrives;
  // the empty state repeats the action as a secondary button.
  const addButton = (variant: "primary" | "secondary") => (
    <Button
      label={t("forwarding.add")}
      variant={variant}
      isDisabled={!data}
      onClick={() => setAdding(true)}
    />
  );

  return (
    <PageFrame title={t("forwarding.title")} actions={addButton("primary")}>
      <Banner
        status="info"
        title={t("forwarding.verifyTitle")}
        description={t("forwarding.verifyDescription")}
      />
      {loadError && <Banner status="error" title={t("settingsPage.loadFailed")} />}
      {!data && !loadError && <TableSkeleton />}
      {data && data.length === 0 && (
        <Center>
          <EmptyState
            icon={<Icon icon={ArrowUturnRightIcon} size="lg" color="secondary" />}
            title={t("forwarding.emptyTitle")}
            description={t("forwarding.emptyDescription")}
            actions={addButton("secondary")}
          />
        </Center>
      )}
      {data && data.length > 0 && (
        <DataTable
          rows={data}
          actionsHeader={t("settingsPage.actions")}
          columns={[
            {
              key: "email",
              header: t("forwarding.email"),
              render: (f) => <Value>{f.email}</Value>,
            },
            { key: "note", header: t("settingsPage.note"), render: (f) => <Text>{f.note}</Text> },
            {
              key: "used",
              header: t("forwarding.usedBy"),
              render: (f) => <Text hasTabularNumbers>{f.addressCount}</Text>,
            },
          ]}
          actions={(f) => (
            <Button
              label={t("settingsPage.remove")}
              variant="ghost"
              size="sm"
              onClick={() => setRemoving(f)}
            />
          )}
        />
      )}

      <FormDialog
        isOpen={adding}
        onClose={() => setAdding(false)}
        title={t("forwarding.addTitle")}
        submitLabel={t("forwarding.add")}
        isSubmitting={busy === "add"}
        onSubmit={() => void onAdd()}
      >
        <TextInput
          type="email"
          label={t("forwarding.email")}
          description={t("forwarding.emailDescription")}
          value={email}
          onChange={setEmail}
          autoCapitalize="none"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          hasAutoFocus
        />
        <TextInput
          label={t("settingsPage.note")}
          value={note}
          onChange={setNote}
          onEnter={() => void onAdd()}
          isOptional
        />
      </FormDialog>

      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("forwarding.removeTitle", { email: removing?.email ?? "" })}
        description={removing ? removeDescription(removing) : ""}
        actionLabel={t("settingsPage.remove")}
        cancelLabel={t("common.cancel")}
        isActionLoading={busy === "remove"}
        onAction={() => removing && void onRemove(removing)}
      />
    </PageFrame>
  );
}
