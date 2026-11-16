import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { ArrowDownIcon, ArrowUpIcon, FunnelIcon } from "@heroicons/react/24/outline";
import { Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { DataTable, TableSkeleton } from "../components/DataTable";
import { PageFrame } from "../components/PageFrame";
import { RuleDialog } from "../rules/RuleDialog";
import { ruleSummary } from "../rules/summary";
import { emptyDraft, type Rule, type RuleDraft, ruleBody } from "../rules/types";
import { type Address, type ForwardTarget, useSettingsPage } from "../settings";

type Data = { rules: Rule[]; targets: ForwardTarget[]; addresses: Address[] };

async function loadAll(): Promise<Data> {
  const [r, f, a] = await Promise.all([
    api<{ rules: Rule[] }>("GET", "/rules"),
    api<{ targets: ForwardTarget[] }>("GET", "/forward-targets"),
    api<{ addresses: Address[] }>("GET", "/addresses"),
  ]);
  return { rules: r.rules, targets: f.targets, addresses: a.addresses };
}

/**
 * Settings > Rules (docs/M6-rules-api.md, "Screens"). The page's copy is its own namespace, so the
 * frame and the skeleton show from the first paint while it loads.
 */
export function RulesPage() {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <PageFrame
          title={t("nav.rules")}
          actions={<Button label={t("rulesPage.create")} variant="primary" isDisabled />}
        >
          <TableSkeleton />
        </PageFrame>
      }
    >
      <RulesBody />
    </Suspense>
  );
}

function RulesBody() {
  const { t } = useTranslation("rules");
  const page = useSettingsPage(loadAll);
  const { data, loadError, busy, act, reload, toast } = page;
  const [editing, setEditing] = useState<Rule | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);

  const open = (rule: Rule | null) => {
    setEditing(rule);
    setDraft(rule ? { ...rule } : emptyDraft());
  };

  const onSave = () =>
    act("save", async () => {
      if (!draft) return;
      if (editing) await api("PUT", `/rules/${editing.id}`, ruleBody(draft));
      else await api("POST", "/rules", ruleBody(draft));
      toast({ body: t(editing ? "saved" : "created") });
      setDraft(null);
      await reload();
    });

  const onToggle = (rule: Rule, enabled: boolean) =>
    act(`enabled:${rule.id}`, async () => {
      await api("PUT", `/rules/${rule.id}`, ruleBody({ ...rule, enabled }));
      await reload();
    });

  const onMove = (index: number, by: -1 | 1) =>
    act(`move:${index}:${by}`, async () => {
      const ids = (data?.rules ?? []).map((r) => r.id);
      const [moved] = ids.splice(index, 1);
      if (moved === undefined) return;
      ids.splice(index + by, 0, moved);
      await api("PUT", "/rules/order", { ids });
      toast({ body: t("moved") });
      await reload();
    });

  const onRemove = (rule: Rule) =>
    act("remove", async () => {
      await api("DELETE", `/rules/${rule.id}`);
      toast({ body: t("removed") });
      setRemoving(null);
      await reload();
    });

  const emailOf = (id: number) => data?.targets.find((x) => x.id === id)?.email ?? "";
  const rules = data?.rules ?? [];
  // The title row keeps its button while loading, so nothing moves when the data arrives;
  // the empty state repeats the action as a secondary button.
  const createButton = (variant: "primary" | "secondary") => (
    <Button label={t("create")} variant={variant} isDisabled={!data} onClick={() => open(null)} />
  );

  return (
    <PageFrame title={t("title")} actions={createButton("primary")}>
      {loadError && <Banner status="error" title={t("loadFailed")} />}
      {!data && !loadError && <TableSkeleton />}
      {data && rules.length === 0 && (
        <Center>
          <EmptyState
            icon={<Icon icon={FunnelIcon} size="lg" color="secondary" />}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
            actions={createButton("secondary")}
          />
        </Center>
      )}
      {data && rules.length > 0 && (
        <DataTable
          rows={rules}
          actionsHeader={t("actionsHeader")}
          columns={[
            {
              key: "name",
              header: t("name"),
              render: (r) => (
                <Text>
                  {t("position", { n: rules.indexOf(r) + 1 })} {r.name}
                </Text>
              ),
            },
            {
              key: "summary",
              header: t("summaryHeader"),
              render: (r) => <Text>{ruleSummary(t, r, emailOf)}</Text>,
            },
            {
              key: "enabled",
              header: t("enabled"),
              render: (r) => (
                <Switch
                  label={t("enabledFor", { name: r.name })}
                  isLabelHidden
                  value={r.enabled}
                  isLoading={busy === `enabled:${r.id}`}
                  onChange={(v) => void onToggle(r, v)}
                />
              ),
            },
          ]}
          actions={(r) => {
            const i = rules.indexOf(r);
            return (
              <HStack gap={1} hAlign="end" wrap="wrap">
                <IconButton
                  label={t("moveUp", { name: r.name })}
                  tooltip={t("moveUp", { name: r.name })}
                  icon={<Icon icon={ArrowUpIcon} />}
                  variant="ghost"
                  size="sm"
                  isDisabled={i === 0}
                  isLoading={busy === `move:${i}:-1`}
                  onClick={() => void onMove(i, -1)}
                />
                <IconButton
                  label={t("moveDown", { name: r.name })}
                  tooltip={t("moveDown", { name: r.name })}
                  icon={<Icon icon={ArrowDownIcon} />}
                  variant="ghost"
                  size="sm"
                  isDisabled={i === rules.length - 1}
                  isLoading={busy === `move:${i}:1`}
                  onClick={() => void onMove(i, 1)}
                />
                <Button label={t("edit")} variant="ghost" size="sm" onClick={() => open(r)} />
                <Button
                  label={t("delete")}
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoving(r)}
                />
              </HStack>
            );
          }}
        />
      )}

      <RuleDialog
        draft={draft}
        isNew={editing === null}
        targets={data?.targets ?? []}
        addresses={(data?.addresses ?? []).map((a) => a.address)}
        isSubmitting={busy === "save"}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSubmit={() => void onSave()}
      />

      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(isOpen) => !isOpen && setRemoving(null)}
        title={t("removeTitle", { name: removing?.name ?? "" })}
        description={t("removeDescription")}
        actionLabel={t("delete")}
        cancelLabel={t("cancel")}
        isActionLoading={busy === "remove"}
        onAction={() => removing && void onRemove(removing)}
      />
    </PageFrame>
  );
}
