import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack, Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api";
import { RecoveryKeySection } from "../components/RecoveryKeySection";
import { RowsSkeleton, SecuritySection } from "../components/SecuritySection";
import { errorMessage } from "../errors";
import { addPasskey, withReauth } from "../passkeys";
import { usePreferences } from "../preferences";
import { describeUserAgent } from "../userAgent";

type Passkey = { id: string; label: string; createdAt: number; lastUsedAt: number | null };
type Session = { createdAt: number; lastSeenAt: number; userAgent: string; current: boolean };
type Data = { passkeys: Passkey[]; sessions: Session[] };
type Confirm = { kind: "passkey"; passkey: Passkey } | { kind: "sessions" };
type ConfirmSpec = { title: string; description: string; actionLabel: string; done: string };

/** Settings > Security: Passkeys, sessions, recovery key and sign-out. */
export function SecurityPage() {
  const { t } = useTranslation();
  const { locale } = usePreferences();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

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

  // What each confirmation says, and the request it confirms.
  const specOf = (c: Confirm): ConfirmSpec =>
    c.kind === "passkey"
      ? {
          title: t("security.removeTitle", { label: c.passkey.label }),
          description: t("security.removeDescription"),
          actionLabel: t("security.remove"),
          done: t("security.passkeyRemoved"),
        }
      : {
          title: t("security.signOutOthersTitle"),
          description: t("security.signOutOthersDescription"),
          actionLabel: t("security.signOutOthers"),
          done: t("security.signedOutOthers"),
        };
  const pathOf = (c: Confirm) =>
    c.kind === "passkey"
      ? `/auth/passkeys/${encodeURIComponent(c.passkey.id)}`
      : "/auth/sessions/others";

  const onConfirm = (c: Confirm) =>
    act("confirm", async () => {
      await withReauth(() => api("DELETE", pathOf(c)));
      toast({ body: specOf(c).done });
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
  const spec = confirm ? specOf(confirm) : null;

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

            <SecuritySection
              title={t("security.passkeys")}
              description={t("security.passkeysDescription")}
            >
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
            </SecuritySection>

            <Divider />

            <SecuritySection
              title={t("security.sessions")}
              description={t("security.sessionsDescription")}
            >
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
            </SecuritySection>

            <Divider />

            <RecoveryKeySection onError={handleError} />

            <Divider />

            <SecuritySection
              title={t("security.signOut")}
              description={t("security.signOutDescription")}
            >
              <HStack>
                <Button
                  label={t("security.signOut")}
                  variant="secondary"
                  isLoading={busy === "signOut"}
                  onClick={() => void onSignOut()}
                />
              </HStack>
            </SecuritySection>
          </VStack>

          <AlertDialog
            isOpen={confirm !== null}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={spec?.title ?? ""}
            description={spec?.description ?? ""}
            actionLabel={spec?.actionLabel ?? ""}
            cancelLabel={t("security.cancel")}
            isActionLoading={busy === "confirm"}
            onAction={() => confirm && void onConfirm(confirm)}
          />
        </LayoutContent>
      }
    />
  );
}
