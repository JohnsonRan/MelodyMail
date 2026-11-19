import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useTheme } from "@astryxdesign/core/theme";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComposeKind } from "../compose/api";
import {
  type Folder,
  getMessage,
  getThread,
  type MessageDetail,
  senderAddress,
  senderName,
} from "../mailbox/api";
import { formatListDate } from "../mailbox/format";
import { useMailbox } from "../mailbox/MailboxContext";
import { SELECTABLE } from "../selection";
import { MessageView } from "./MessageView";
import { type ReaderAction, ReaderToolbar } from "./ReaderToolbar";
import { SentStatus } from "./SentStatus";

// A sender address longer than the line wraps rather than running off a phone screen.
const WRAP_ANYWHERE = { overflowWrap: "anywhere" } as const;

type Props = {
  id: string;
  folder: Folder | "search";
  showBack: boolean;
  onBack: () => void;
  /** Runs an action on the open message; resolves true when it succeeded. */
  onAction: (action: ReaderAction, message: MessageDetail) => Promise<boolean>;
  /** Called once the open message is shown, so the page can mark it read. */
  onOpened: (message: MessageDetail) => void;
  /** Reply, reply all or forward the open message, or send it again as a new one. */
  onCompose: (kind: ComposeKind, message: MessageDetail) => void;
  busy: string | null;
  /** Side by side the pane pads itself; alone, the page frame already does. */
  isPadded: boolean;
};

/** The set with `id` added or removed; the same set when nothing changes. */
function withMember(set: Set<string>, id: string, has: boolean): Set<string> {
  if (set.has(id) === has) return set;
  const next = new Set(set);
  if (has) next.add(id);
  else next.delete(id);
  return next;
}

/** A message in Spam loads no remote images, whatever the owner chose for it. */
const inSpam = (m: MessageDetail) => m.spam && !m.trashed;

type Thread =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; messages: MessageDetail[] };

/** The thread view, oldest first, with the newest and the opened message expanded. */
export default function Reader({
  id,
  folder,
  showBack,
  onBack,
  onAction,
  onOpened,
  onCompose,
  busy,
  isPadded,
}: Props) {
  const { t, i18n } = useTranslation();
  const [thread, setThread] = useState<Thread>({ state: "loading" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [remote, setRemote] = useState<Set<string>>(new Set());
  const [allowRemote, setAllowRemote] = useState<Set<string>>(new Set());
  const [html, setHtml] = useState<Set<string>>(new Set());
  // Dark reading is per message, off by default and not remembered (owner ruling 2026-11-16).
  const [dark, setDark] = useState<Set<string>>(new Set());
  const { mode } = useTheme();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { onMail } = useMailbox();

  useEffect(() => {
    let live = true;
    setThread({ state: "loading" });
    setAllowRemote(new Set());
    setRemote(new Set());
    getThread(id)
      .then(({ messages }) => {
        if (!live) return;
        setThread({ state: "ready", messages });
        setExpanded(new Set([id, messages.at(-1)?.id ?? id]));
      })
      .catch(() => live && setThread({ state: "failed" }));
    return () => {
      live = false;
    };
  }, [id]);

  // The consumer filed a message of this thread into Spam: take its new flags, so it stops
  // loading remote images and shows the Spam actions (docs/M8-mailbox-ux.md, "Filing").
  useEffect(
    () =>
      onMail((event) => {
        if (event.type !== "filed") return;
        getMessage(event.id)
          .then(({ message }) =>
            setThread((prev) =>
              prev.state === "ready"
                ? {
                    state: "ready",
                    messages: prev.messages.map((m) => (m.id === message.id ? message : m)),
                  }
                : prev,
            ),
          )
          .catch(() => {});
      }),
    [onMail],
  );

  const current = thread.state === "ready" ? thread.messages.find((m) => m.id === id) : undefined;
  // Mark read once per opened message, not again when its flags change.
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (current && marked.current !== current.id) {
      marked.current = current.id;
      onOpened(current);
    }
  }, [current, onOpened]);

  const reportContent = useCallback(
    (messageId: string, content: { remote: boolean; html: boolean }) => {
      setRemote((prev) => withMember(prev, messageId, content.remote));
      setHtml((prev) => withMember(prev, messageId, content.html));
    },
    [],
  );

  const setStatus = (messageId: string, status: string) =>
    setThread((prev) =>
      prev.state === "ready"
        ? {
            state: "ready",
            messages: prev.messages.map((m) =>
              m.id === messageId ? { ...m, status: status as MessageDetail["status"] } : m,
            ),
          }
        : prev,
    );

  const run = async (action: ReaderAction) => {
    if (!current) return;
    const ok = await onAction(action, current);
    if (ok && (action === "star" || action === "unstar") && thread.state === "ready") {
      setThread({
        state: "ready",
        messages: thread.messages.map((m) =>
          m.id === current.id ? { ...m, starred: action === "star" } : m,
        ),
      });
    }
  };

  const inTrash = current?.trashed ?? folder === "trash";
  const spam = current ? inSpam(current) : folder === "spam";
  const canShowRemote =
    current !== undefined && !spam && remote.has(current.id) && !allowRemote.has(current.id);
  const toolbar = (
    <ReaderToolbar
      current={current}
      inTrash={inTrash}
      inSpam={spam}
      showBack={showBack}
      onBack={onBack}
      busy={busy}
      run={(action) => void run(action)}
      canShowRemote={canShowRemote}
      onShowRemote={() => current && setAllowRemote((prev) => new Set(prev).add(current.id))}
      onDelete={() => setConfirmDelete(true)}
      darkReading={current && mode === "dark" && html.has(current.id) ? dark.has(current.id) : null}
      onDarkReading={(on) => current && setDark((prev) => withMember(prev, current.id, on))}
      onCompose={(kind) => current && onCompose(kind, current)}
    />
  );

  return (
    <VStack gap={4} hAlign="stretch" padding={isPadded ? 4 : 0}>
      {toolbar}
      {thread.state === "loading" && (
        <VStack gap={3} hAlign="stretch">
          <Skeleton height="var(--size-control-lg)" />
          <Skeleton height="var(--size-control-lg)" index={1} />
          <Skeleton height="var(--size-control-lg)" index={2} />
        </VStack>
      )}
      {thread.state === "failed" && <Banner status="error" title={t("mail.threadFailed")} />}
      {thread.state === "ready" && (
        <>
          <Heading level={2} style={SELECTABLE}>
            {current?.subject || t("mail.noSubject")}
          </Heading>
          {current?.direction === "out" && (
            <SentStatus
              message={current}
              onRetried={(status) => setStatus(current.id, status)}
              onSendAsNew={() => onCompose("again", current)}
            />
          )}
          {canShowRemote && (
            <Text type="supporting" color="secondary">
              {t("mail.remoteBlocked")}
            </Text>
          )}
          {spam && current && remote.has(current.id) && (
            <Text type="supporting" color="secondary">
              {t("mail.spamRemoteBlocked")}
            </Text>
          )}
          {thread.messages.map((m) => (
            <Collapsible
              key={m.id}
              isOpen={expanded.has(m.id)}
              onOpenChange={(open) =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (open) next.add(m.id);
                  else next.delete(m.id);
                  return next;
                })
              }
              trigger={
                <HStack gap={2} vAlign="center" style={SELECTABLE}>
                  <StackItem size="fill">
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Text weight={m.read ? "normal" : "semibold"}>{senderName(m.from)}</Text>
                      {senderAddress(m.from) !== senderName(m.from) && (
                        <Text type="supporting" color="secondary" style={WRAP_ANYWHERE}>
                          {senderAddress(m.from)}
                        </Text>
                      )}
                    </HStack>
                  </StackItem>
                  <Text type="supporting" textWrap="nowrap">
                    {formatListDate(m.receivedAt, i18n.language)}
                  </Text>
                </HStack>
              }
            >
              {expanded.has(m.id) && (
                <MessageView
                  message={m}
                  remoteImages={allowRemote.has(m.id) && !inSpam(m)}
                  darkReading={mode === "dark" && dark.has(m.id)}
                  onContent={reportContent}
                />
              )}
            </Collapsible>
          ))}
        </>
      )}
      <AlertDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("mail.deleteForeverTitle")}
        description={t("mail.deleteForeverDescription")}
        actionLabel={t("mail.deleteForever")}
        cancelLabel={t("common.cancel")}
        isActionLoading={busy === "delete"}
        onAction={async () => {
          await run("delete");
          setConfirmDelete(false);
        }}
      />
    </VStack>
  );
}
