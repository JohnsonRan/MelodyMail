import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  ArrowUturnLeftIcon,
  EnvelopeIcon,
  InboxArrowDownIcon,
  PhotoIcon,
  StarIcon as StarOutline,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/24/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type Folder,
  getThread,
  type MessageDetail,
  senderAddress,
  senderName,
} from "../mailbox/api";
import { formatListDate } from "../mailbox/format";
import { MessageView } from "./MessageView";

export type ReaderAction =
  | "archive"
  | "unarchive"
  | "trash"
  | "restore"
  | "star"
  | "unstar"
  | "unread"
  | "delete";

type Props = {
  id: string;
  folder: Folder | "search";
  showBack: boolean;
  onBack: () => void;
  /** Runs an action on the open message; resolves true when it succeeded. */
  onAction: (action: ReaderAction, message: MessageDetail) => Promise<boolean>;
  /** Called once the open message is shown, so the page can mark it read. */
  onOpened: (message: MessageDetail) => void;
  busy: string | null;
  /** Side by side the pane pads itself; alone, the page frame already does. */
  isPadded: boolean;
};

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
  busy,
  isPadded,
}: Props) {
  const { t, i18n } = useTranslation();
  const [thread, setThread] = useState<Thread>({ state: "loading" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [remote, setRemote] = useState<Set<string>>(new Set());
  const [allowRemote, setAllowRemote] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const current = thread.state === "ready" ? thread.messages.find((m) => m.id === id) : undefined;
  // Mark read once per opened message, not again when its flags change.
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (current && marked.current !== current.id) {
      marked.current = current.id;
      onOpened(current);
    }
  }, [current, onOpened]);

  const reportRemote = useCallback(
    (messageId: string, has: boolean) =>
      setRemote((prev) => {
        if (prev.has(messageId) === has) return prev;
        const next = new Set(prev);
        if (has) next.add(messageId);
        else next.delete(messageId);
        return next;
      }),
    [],
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
  const toolbar = (
    <Toolbar
      label={t("mail.messageActions")}
      startContent={
        <>
          {showBack && (
            <IconButton
              label={t("mail.backToList")}
              tooltip={t("mail.backToList")}
              icon={<Icon icon={ArrowLeftIcon} />}
              variant="ghost"
              onClick={onBack}
            />
          )}
          {current && !inTrash && (
            <IconButton
              label={current.archived ? t("mail.moveToInbox") : t("mail.archive")}
              tooltip={current.archived ? t("mail.moveToInbox") : t("mail.archive")}
              icon={<Icon icon={current.archived ? InboxArrowDownIcon : ArchiveBoxIcon} />}
              variant="ghost"
              isLoading={busy === "archive" || busy === "unarchive"}
              onClick={() => void run(current.archived ? "unarchive" : "archive")}
            />
          )}
          {current && (
            <IconButton
              label={inTrash ? t("mail.restore") : t("mail.trash")}
              tooltip={inTrash ? t("mail.restore") : t("mail.trash")}
              icon={<Icon icon={inTrash ? ArrowUturnLeftIcon : TrashIcon} />}
              variant="ghost"
              isLoading={busy === "trash" || busy === "restore"}
              onClick={() => void run(inTrash ? "restore" : "trash")}
            />
          )}
          {current && (
            <IconButton
              label={current.starred ? t("mail.unstar") : t("mail.star")}
              tooltip={current.starred ? t("mail.unstar") : t("mail.star")}
              icon={<Icon icon={current.starred ? StarIcon : StarOutline} />}
              variant="ghost"
              isLoading={busy === "star" || busy === "unstar"}
              onClick={() => void run(current.starred ? "unstar" : "star")}
            />
          )}
          {current && (
            <IconButton
              label={t("mail.markUnread")}
              tooltip={t("mail.markUnread")}
              icon={<Icon icon={EnvelopeIcon} />}
              variant="ghost"
              isLoading={busy === "unread"}
              onClick={() => void run("unread")}
            />
          )}
          {current && remote.has(current.id) && !allowRemote.has(current.id) && (
            <IconButton
              label={t("mail.showRemoteImages")}
              tooltip={t("mail.showRemoteImages")}
              icon={<Icon icon={PhotoIcon} />}
              variant="ghost"
              onClick={() => setAllowRemote((prev) => new Set(prev).add(current.id))}
            />
          )}
        </>
      }
      endContent={
        current &&
        inTrash && (
          <IconButton
            label={t("mail.deleteForever")}
            tooltip={t("mail.deleteForever")}
            icon={<Icon icon={TrashIcon} />}
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
          />
        )
      }
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
          <Heading level={2}>{current?.subject || t("mail.noSubject")}</Heading>
          {current && remote.has(current.id) && !allowRemote.has(current.id) && (
            <Text type="supporting" color="secondary">
              {t("mail.remoteBlocked")}
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
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Text weight={m.read ? "normal" : "semibold"}>{senderName(m.from)}</Text>
                      {senderAddress(m.from) !== senderName(m.from) && (
                        <Text type="supporting" color="secondary">
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
                  remoteImages={allowRemote.has(m.id)}
                  onRemoteContent={reportRemote}
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
