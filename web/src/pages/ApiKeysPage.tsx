import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { KeyIcon } from "@heroicons/react/24/outline";
import { Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import {
  CreateKeyDialog,
  emptyKeyDraft,
  type KeyDraft,
  keyBody,
  type Scope,
  scopeKey,
} from "../apiKeys/CreateKeyDialog";
import { DataTable, TableSkeleton, Value } from "../components/DataTable";
import { PageFrame } from "../components/PageFrame";
import { RecoveryKeyPanel } from "../components/RecoveryKeyPanel";
import { withReauth } from "../passkeys";
import { usePreferences } from "../preferences";
import { useSettingsPage } from "../settings";

type ApiKey = {
  id: number;
  publicId: string;
  label: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
};

/**
 * Settings > API keys (docs/M6-rules-api.md, "Screens"). The page's copy is its own namespace, so
 * the frame and the skeleton show from the first paint while it loads.
 */
export function ApiKeysPage() {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <PageFrame
          title={t("nav.apiKeys")}
          actions={<Button label={t("apiKeysPage.create")} variant="primary" isDisabled />}
        >
          <TableSkeleton />
        </PageFrame>
      }
    >
      <ApiKeysBody />
    </Suspense>
  );
}

function ApiKeysBody() {
  const { t } = useTranslation("apiKeys");
  const { locale } = usePreferences();
  const page = useSettingsPage(async () => {
    const data = await api<{ apiKeys: ApiKey[] }>("GET", "/keys");
    return data.apiKeys;
  });
  const { data, loadError, busy, act, reload, toast } = page;
  const [draft, setDraft] = useState<KeyDraft | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const date = (ms: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms);

  const onCreate = () =>
    act("create", async () => {
      if (!draft) return;
      const body = keyBody(draft);
      const done = await withReauth(() => api<{ key: string }>("POST", "/keys", body));
      setDraft(null);
      setCreated(done.key);
      await reload();
    });

  const onRevoke = (key: ApiKey) =>
    act("revoke", async () => {
      await api("DELETE", `/keys/${key.id}`);
      toast({ body: t("revoked") });
      setRevoking(null);
      await reload();
    });

  const expires = (k: ApiKey) => {
    if (k.expiresAt === null) return t("neverExpires");
    if (k.expiresAt <= Date.now()) return t("expired");
    return date(k.expiresAt);
  };

  // The title row keeps its button while loading, so nothing moves when the data arrives; the
  // empty state repeats the action as a secondary button.
  const createButton = (variant: "primary" | "secondary") => (
    <Button
      label={t("create")}
      variant={variant}
      isDisabled={!data}
      onClick={() => setDraft(emptyKeyDraft())}
    />
  );

  return (
    <PageFrame title={t("title")} actions={createButton("primary")}>
      <Text>
        {t("intro")}{" "}
        <Link href="/api/openapi.json" download="melodymail-openapi.json">
          {t("openapi")}
        </Link>
      </Text>
      {loadError && <Banner status="error" title={t("loadFailed")} />}
      {!data && !loadError && <TableSkeleton />}
      {data && data.length === 0 && (
        <Center>
          <EmptyState
            icon={<Icon icon={KeyIcon} size="lg" color="secondary" />}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
            actions={createButton("secondary")}
          />
        </Center>
      )}
      {data && data.length > 0 && (
        <DataTable
          rows={data}
          actionsHeader={t("actionsHeader")}
          columns={[
            { key: "label", header: t("label"), render: (k) => <Text>{k.label}</Text> },
            {
              key: "key",
              header: t("key"),
              render: (k) => <Value>{`mmk_${k.publicId}_…`}</Value>,
            },
            {
              key: "scopes",
              header: t("scopes"),
              render: (k) => (
                <Text>{k.scopes.map((s) => t(`scope.${scopeKey(s)}`)).join(", ")}</Text>
              ),
            },
            {
              key: "created",
              header: t("created"),
              render: (k) => <Text>{date(k.createdAt)}</Text>,
            },
            { key: "expires", header: t("expires"), render: (k) => <Text>{expires(k)}</Text> },
            {
              key: "lastUsed",
              header: t("lastUsed"),
              render: (k) =>
                k.lastUsedAt === null ? (
                  <Text>{t("neverUsed")}</Text>
                ) : (
                  <VStack gap={0}>
                    <Text>{date(k.lastUsedAt)}</Text>
                    {k.lastUsedIp && <Value>{k.lastUsedIp}</Value>}
                  </VStack>
                ),
            },
          ]}
          actions={(k) => (
            <Button
              label={t("revoke")}
              variant="ghost"
              size="sm"
              tooltip={t("revokeFor", { label: k.label })}
              onClick={() => setRevoking(k)}
            />
          )}
        />
      )}

      <CreateKeyDialog
        draft={draft}
        isSubmitting={busy === "create"}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSubmit={() => void onCreate()}
      />

      <Dialog isOpen={created !== null} onOpenChange={() => {}} purpose="required" padding={6}>
        <DialogHeader title={t("createdTitle")} />
        {created && (
          <RecoveryKeyPanel
            recoveryKey={created}
            isApiKey
            notice={t("createdNotice")}
            confirmLabel={t("copiedConfirm")}
            continueLabel={t("done")}
            onContinue={() => setCreated(null)}
          />
        )}
      </Dialog>

      <AlertDialog
        isOpen={revoking !== null}
        onOpenChange={(isOpen) => !isOpen && setRevoking(null)}
        title={t("revokeTitle", { label: revoking?.label ?? "" })}
        description={t("revokeDescription")}
        actionLabel={t("revoke")}
        cancelLabel={t("cancel")}
        isActionLoading={busy === "revoke"}
        onAction={() => revoking && void onRevoke(revoking)}
      />
    </PageFrame>
  );
}
