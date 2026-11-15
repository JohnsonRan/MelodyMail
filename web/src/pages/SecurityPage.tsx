import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api";
import { RecoveryKeyPanel } from "../components/RecoveryKeyPanel";
import { errorMessage } from "../errors";
import { addPasskey, withReauth } from "../passkeys";
import { usePreferences } from "../preferences";
import { describeUserAgent } from "../userAgent";

type Passkey = { id: string; label: string; createdAt: number; lastUsedAt: number | null };
type Session = { createdAt: number; lastSeenAt: number; userAgent: string; current: boolean };
type Data = { passkeys: Passkey[]; sessions: Session[] };
type Confirm =
  | { kind: "passkey"; passkey: Passkey }
  | { kind: "sessions" }
  | { kind: "recoveryKey" }
  | null;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Grid columns={{ minWidth: 320 }} gap={10}>
      <VStack gap={1}>
        <Heading level={2}>{title}</Heading>
        <Text type="supporting" color="secondary">
          {description}
        </Text>
      </VStack>
      <VStack gap={4} hAlign="stretch">
        {children}
      </VStack>
    </Grid>
  );
}

function RowsSkeleton() {
  return (
    <VStack gap={2} hAlign="stretch">
      {[0, 1].map((i) => (
        <Skeleton key={i} height="var(--size-control-lg)" index={i} />
      ))}
    </VStack>
  );
}

/** Settings > Security: Passkeys, sessions and sign-out. */
export function SecurityPage() {
  const { t } = useTranslation();
  const { locale } = usePreferences();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);

  const formatDate = (ms: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms);

  const handleError = useCallback(
    async (err: unknown) => {
      if (err instanceof ApiError && err.code === "unauthorized") {
        await navigate({ to: "/login" });
        return;
      }
      toast({ body: errorMessage(t, err), type: "error" });
    },
    [navigate, t, toast],
  );

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        api<{ passkeys: Passkey[] }>("GET", "/auth/passkeys"),
        api<{ sessions: Session[] }>("GET", "/auth/sessions"),
      ]);
      setData({ passkeys: p.passkeys, sessions: s.sessions });
      setLoadError(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthorized") await handleError(err);
      else setLoadError(true);
    }
  }, [handleError]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    try {
      await action();
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(null);
    }
  };

  const onAddPasskey = () =>
    act("add", async () => {
      await addPasskey(t("passkeyDefaultLabel"));
      toast({ body: t("security.passkeyAdded") });
      await load();
    });

  const onConfirm = () =>
    act("confirm", async () => {
      if (confirm?.kind === "passkey") {
        const path = `/auth/passkeys/${encodeURIComponent(confirm.passkey.id)}`;
        await withReauth(() => api("DELETE", path));
        toast({ body: t("security.passkeyRemoved") });
      } else if (confirm?.kind === "sessions") {
        await withReauth(() => api("DELETE", "/auth/sessions/others"));
        toast({ body: t("security.signedOutOthers") });
      } else if (confirm?.kind === "recoveryKey") {
        const done = await withReauth(() =>
          api<{ recoveryKey: string }>("POST", "/auth/recovery-key", {}),
        );
        setNewRecoveryKey(done.recoveryKey);
      }
      setConfirm(null);
      await load();
    });

  const onSignOut = () =>
    act("signOut", async () => {
      await api("POST", "/auth/logout", {});
      await navigate({ to: "/login" });
    });

  const onlyOne = data?.passkeys.length === 1;
  const others = data ? data.sessions.filter((s) => !s.current).length : 0;

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Heading level={1}>{t("security.title")}</Heading>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={4}>
          <VStack gap={4}>
            {loadError && <Banner status="error" title={t("security.loadFailed")} />}

            <Section title={t("security.passkeys")} description={t("security.passkeysDescription")}>
              {data ? (
                <List>
                  {data.passkeys.map((p) => (
                    <ListItem
                      key={p.id}
                      itemKey={p.id}
                      label={p.label}
                      description={`${t("security.created", { date: formatDate(p.createdAt) })} · ${
                        p.lastUsedAt
                          ? t("security.lastUsed", { date: formatDate(p.lastUsedAt) })
                          : t("security.neverUsed")
                      }`}
                      endContent={
                        <Button
                          label={t("security.remove")}
                          variant="ghost"
                          size="sm"
                          isDisabled={onlyOne}
                          onClick={() => setConfirm({ kind: "passkey", passkey: p })}
                        />
                      }
                    />
                  ))}
                </List>
              ) : (
                <RowsSkeleton />
              )}
              {onlyOne && (
                <Text type="supporting" color="secondary">
                  {t("security.lastPasskey")}
                </Text>
              )}
              <HStack>
                <Button
                  label={t("security.addPasskey")}
                  variant="secondary"
                  isLoading={busy === "add"}
                  isDisabled={!data}
                  onClick={() => void onAddPasskey()}
                />
              </HStack>
            </Section>

            <Divider />

            <Section title={t("security.sessions")} description={t("security.sessionsDescription")}>
              {data ? (
                <List>
                  {data.sessions.map((s) => (
                    <ListItem
                      key={`${s.createdAt}-${s.userAgent}`}
                      label={describeUserAgent(s.userAgent) ?? t("security.unknownDevice")}
                      description={t("security.lastSeen", { date: formatDate(s.lastSeenAt) })}
                      endContent={
                        s.current ? (
                          <Text type="supporting" color="secondary">
                            {t("security.thisDevice")}
                          </Text>
                        ) : undefined
                      }
                    />
                  ))}
                </List>
              ) : (
                <RowsSkeleton />
              )}
              <HStack>
                <Button
                  label={t("security.signOutOthers")}
                  variant="secondary"
                  isDisabled={others === 0}
                  onClick={() => setConfirm({ kind: "sessions" })}
                />
              </HStack>
            </Section>

            <Divider />

            <Section
              title={t("security.recoveryKey")}
              description={t("security.recoveryKeyDescription")}
            >
              <HStack>
                <Button
                  label={t("security.regenerateKey")}
                  variant="secondary"
                  onClick={() => setConfirm({ kind: "recoveryKey" })}
                />
              </HStack>
            </Section>

            <Divider />

            <Section title={t("security.signOut")} description={t("security.signOutDescription")}>
              <HStack>
                <Button
                  label={t("security.signOut")}
                  variant="secondary"
                  isLoading={busy === "signOut"}
                  onClick={() => void onSignOut()}
                />
              </HStack>
            </Section>
          </VStack>

          <AlertDialog
            isOpen={confirm !== null}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={
              confirm?.kind === "sessions"
                ? t("security.signOutOthersTitle")
                : confirm?.kind === "recoveryKey"
                  ? t("security.regenerateKeyTitle")
                  : t("security.removeTitle", {
                      label: confirm?.kind === "passkey" ? confirm.passkey.label : "",
                    })
            }
            description={
              confirm?.kind === "sessions"
                ? t("security.signOutOthersDescription")
                : confirm?.kind === "recoveryKey"
                  ? t("security.regenerateKeyDescription")
                  : t("security.removeDescription")
            }
            actionLabel={
              confirm?.kind === "sessions"
                ? t("security.signOutOthers")
                : confirm?.kind === "recoveryKey"
                  ? t("security.regenerateKey")
                  : t("security.remove")
            }
            cancelLabel={t("security.cancel")}
            isActionLoading={busy === "confirm"}
            onAction={() => void onConfirm()}
          />

          <Dialog
            isOpen={newRecoveryKey !== null}
            onOpenChange={() => {}}
            purpose="required"
            padding={6}
          >
            <DialogHeader title={t("recover.newKeyTitle")} />
            {newRecoveryKey && (
              <RecoveryKeyPanel
                recoveryKey={newRecoveryKey}
                notice={t("recoveryKey.rotatedNotice")}
                continueLabel={t("security.recoveryKeySaved")}
                onContinue={() => setNewRecoveryKey(null)}
              />
            )}
          </Dialog>
        </LayoutContent>
      }
    />
  );
}
