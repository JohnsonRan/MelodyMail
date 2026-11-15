import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  InboxArrowDownIcon,
  InboxIcon,
  MagnifyingGlassIcon,
  StarIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import { PageFrame } from "../components/PageFrame";
import { errorMessage } from "../errors";
import {
  deleteForever,
  type Flags,
  type ListQuery,
  listMessages,
  type MessageItem,
  setFlags,
} from "../mailbox/api";
import { useMailbox } from "../mailbox/MailboxContext";
import { MessageList, rowElement } from "../mailbox/MessageList";
import { useMailShortcuts } from "../mailbox/useMailShortcuts";
import type { ReaderAction } from "../reader/Reader";

// The reader, postal-mime and DOMPurify load only when a message is opened.
const Reader = lazy(() => import("../reader/Reader"));

// At laptop width and wider the list and the reader sit side by side; below it, one pane at a
// time (docs/M4-mailbox.md, "Layout by width"; REQUIREMENTS.md, supported widths).
const SIDE_BY_SIDE = "(min-width: 1280px)";

type ListState = {
  items: MessageItem[];
  next: string | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
};

const LOADING: ListState = { items: [], next: null, status: "loading", loadingMore: false };

/** Whether a message still belongs in the list after its flags changed. */
function belongs(item: MessageItem, query: ListQuery): boolean {
  if ("search" in query) return !item.trashed;
  switch (query.folder) {
    case "inbox":
      return !item.trashed && !item.archived;
    case "starred":
      return item.starred && !item.trashed;
    case "archive":
      return item.archived && !item.trashed;
    case "trash":
      return item.trashed;
  }
}

const ACTION_FLAGS: Record<Exclude<ReaderAction, "delete">, Flags> = {
  archive: { archived: true },
  unarchive: { archived: false },
  trash: { trashed: true },
  restore: { trashed: false },
  star: { starred: true },
  unstar: { starred: false },
  unread: { read: false },
};

type BulkAction = Exclude<ReaderAction, "delete"> | "read";

function ListSkeleton() {
  return (
    <VStack gap={2} hAlign="stretch">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} height="calc(var(--size-control-lg) * 2)" index={i} />
      ))}
    </VStack>
  );
}

export function MailboxPage({ query, title }: { query: ListQuery; title: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname, openId, q } = useRouterState({
    select: (s) => ({
      pathname: s.location.pathname,
      openId: typeof s.location.search.m === "string" ? s.location.search.m : null,
      q: typeof s.location.search.q === "string" ? s.location.search.q : undefined,
    }),
    structuralSharing: true,
  });
  const sideBySide = useMediaQuery(SIDE_BY_SIDE);
  const { refreshCounts, onMail } = useMailbox();
  const [list, setList] = useState<ListState>(LOADING);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const sentinel = useRef<HTMLElement>(null);
  const queryKey = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  const go = useCallback(
    (m: string | null) => {
      const search = { ...(q === undefined ? {} : { q }), ...(m ? { m } : {}) };
      void navigate({ to: pathname as "/", search: search as never });
    },
    [navigate, pathname, q],
  );

  const failed = useCallback(
    async (err: unknown) => {
      if (err instanceof ApiError && err.code === "unauthorized") {
        await navigate({ to: "/login" });
        return;
      }
      toast({ body: errorMessage(t, err), type: "error" });
    },
    [navigate, t, toast],
  );

  const reload = useCallback(async () => {
    setList(LOADING);
    setSelected(new Set());
    setCursor(0);
    try {
      const page = await listMessages(queryRef.current);
      setList({ items: page.messages, next: page.nextCursor, status: "ready", loadingMore: false });
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthorized") await failed(err);
      else setList({ ...LOADING, status: "error" });
    }
  }, [failed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey is the trigger.
  useEffect(() => {
    void reload();
  }, [queryKey, reload]);

  const loadMore = useCallback(async () => {
    if (list.status !== "ready" || !list.next || list.loadingMore) return;
    setList((prev) => ({ ...prev, loadingMore: true }));
    try {
      const page = await listMessages(queryRef.current, list.next);
      setList((prev) => {
        const known = new Set(prev.items.map((m) => m.id));
        return {
          ...prev,
          items: [...prev.items, ...page.messages.filter((m) => !known.has(m.id))],
          next: page.nextCursor,
          loadingMore: false,
        };
      });
    } catch (err) {
      setList((prev) => ({ ...prev, loadingMore: false }));
      await failed(err);
    }
  }, [failed, list.loadingMore, list.next, list.status]);

  // The next page loads when the end of the list scrolls into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !list.next) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [list.next, loadMore]);

  // New mail: the first page is fetched again and its new messages go on top.
  useEffect(
    () =>
      onMail(() => {
        listMessages(queryRef.current)
          .then((page) =>
            setList((prev) => {
              if (prev.status !== "ready") return prev;
              const known = new Set(prev.items.map((m) => m.id));
              const fresh = page.messages.filter((m) => !known.has(m.id));
              return fresh.length > 0 ? { ...prev, items: [...fresh, ...prev.items] } : prev;
            }),
          )
          .catch(() => {});
      }),
    [onMail],
  );

  /** Applies changed flags locally; messages that leave the view are removed. */
  const applyLocal = useCallback((ids: string[], flags: Flags | "deleted") => {
    const set = new Set(ids);
    setList((prev) => ({
      ...prev,
      items: prev.items
        .map((m) => (set.has(m.id) && flags !== "deleted" ? { ...m, ...flags } : m))
        .filter((m) => !(set.has(m.id) && (flags === "deleted" || !belongs(m, queryRef.current)))),
    }));
  }, []);

  const act = useCallback(
    async (name: string, ids: string[], flags: Flags | "deleted"): Promise<boolean> => {
      if (running.current || ids.length === 0) return false;
      running.current = true;
      setBusy(name);
      try {
        if (flags === "deleted") {
          for (const id of ids) await deleteForever(id);
        } else {
          await setFlags(ids, flags);
        }
        applyLocal(ids, flags);
        const leaves =
          flags === "deleted" ||
          list.items.some((m) => ids.includes(m.id) && !belongs({ ...m, ...flags }, query));
        if (leaves && openId && ids.includes(openId)) go(null);
        if (leaves) setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
        const notice = {
          archive: "archived",
          trash: "trashed",
          restore: "restored",
          delete: "deleted",
        }[name];
        if (notice) toast({ body: t(`mail.done.${notice}`, { count: ids.length }) });
        void refreshCounts();
        return true;
      } catch (err) {
        await failed(err);
        return false;
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [applyLocal, failed, go, list.items, openId, query, refreshCounts, t, toast],
  );

  const onOpened = useCallback(
    (message: MessageItem) => {
      if (message.read) return;
      setFlags([message.id], { read: true })
        .then(() => {
          applyLocal([message.id], { read: true });
          void refreshCounts();
        })
        .catch(() => {});
    },
    [applyLocal, refreshCounts],
  );

  const onReaderAction = useCallback(
    (action: ReaderAction, message: MessageItem) =>
      act(action, [message.id], action === "delete" ? "deleted" : ACTION_FLAGS[action]),
    [act],
  );

  const inTrash = "folder" in query && query.folder === "trash";
  const inArchive = "folder" in query && query.folder === "archive";
  const chosen = list.items.filter((m) => selected.has(m.id));
  const allStarred = chosen.length > 0 && chosen.every((m) => m.starred);
  const allRead = chosen.length > 0 && chosen.every((m) => m.read);

  const bulk = (action: BulkAction) => {
    const flags = action === "read" ? { read: true } : ACTION_FLAGS[action];
    void act(action, [...selected], flags);
  };

  /** What a shortcut acts on: the selection, else the open message, else the focused row. */
  const targets = (): string[] => {
    if (selected.size > 0) return [...selected];
    if (openId) return [openId];
    const row = list.items[cursor];
    return row ? [row.id] : [];
  };

  const moveCursor = (delta: number) => {
    const index = Math.max(0, Math.min(list.items.length - 1, cursor + delta));
    const item = list.items[index];
    if (!item) return;
    setCursor(index);
    rowElement(item.id)?.focus();
  };

  useMailShortcuts({
    next: () => moveCursor(1),
    previous: () => moveCursor(-1),
    open: () => {
      const item = list.items[cursor];
      if (item) go(item.id);
    },
    archive: () => {
      if (inTrash) return;
      void act(inArchive ? "unarchive" : "archive", targets(), { archived: !inArchive });
    },
    trash: () => void act(inTrash ? "restore" : "trash", targets(), { trashed: !inTrash }),
    star: () => {
      const ids = targets();
      const items = list.items.filter((m) => ids.includes(m.id));
      const star = !(items.length > 0 && items.every((m) => m.starred));
      void act(star ? "star" : "unstar", ids, { starred: star });
    },
    back: () => go(null),
    search: () => document.querySelector<HTMLInputElement>('input[type="search"]')?.focus(),
  });

  const emptyTitle = "search" in query ? t("mail.noResults") : t(`mail.empty.${query.folder}`);
  const listBody = (
    <>
      {list.status === "loading" && <ListSkeleton />}
      {list.status === "error" && (
        <Banner
          status="error"
          title={t("mail.listFailed")}
          endContent={
            <Button
              label={t("mail.retry")}
              variant="secondary"
              size="sm"
              onClick={() => void reload()}
            />
          }
        />
      )}
      {list.status === "ready" && list.items.length === 0 && (
        <Center height="100%">
          <EmptyState
            icon={
              <Icon
                icon={"search" in query ? MagnifyingGlassIcon : InboxIcon}
                size="lg"
                color="secondary"
              />
            }
            title={emptyTitle}
            description={"search" in query ? t("mail.noResultsDescription") : undefined}
          />
        </Center>
      )}
      {list.status === "ready" && list.items.length > 0 && (
        <MessageList
          messages={list.items}
          openId={openId}
          onOpen={(item) => go(item.id)}
          selected={selected}
          setSelected={setSelected}
          onCursor={setCursor}
        />
      )}
      {list.next && <VStack ref={sentinel} height="var(--spacing-1)" />}
      {list.loadingMore && <Skeleton height="calc(var(--size-control-lg) * 2)" />}
    </>
  );

  const bulkBar = (
    <Toolbar
      label={t("mail.listActions")}
      startContent={
        <>
          {!inTrash && (
            <IconButton
              label={inArchive ? t("mail.moveToInbox") : t("mail.archive")}
              tooltip={inArchive ? t("mail.moveToInbox") : t("mail.archive")}
              icon={<Icon icon={inArchive ? InboxArrowDownIcon : ArchiveBoxIcon} />}
              variant="ghost"
              isDisabled={selected.size === 0}
              isLoading={busy === "archive" || busy === "unarchive"}
              onClick={() => bulk(inArchive ? "unarchive" : "archive")}
            />
          )}
          <IconButton
            label={inTrash ? t("mail.restore") : t("mail.trash")}
            tooltip={inTrash ? t("mail.restore") : t("mail.trash")}
            icon={<Icon icon={inTrash ? ArrowUturnLeftIcon : TrashIcon} />}
            variant="ghost"
            isDisabled={selected.size === 0}
            isLoading={busy === "trash" || busy === "restore"}
            onClick={() => bulk(inTrash ? "restore" : "trash")}
          />
          <IconButton
            label={allStarred ? t("mail.unstar") : t("mail.star")}
            tooltip={allStarred ? t("mail.unstar") : t("mail.star")}
            icon={<Icon icon={StarIcon} />}
            variant="ghost"
            isDisabled={selected.size === 0}
            isLoading={busy === "star" || busy === "unstar"}
            onClick={() => bulk(allStarred ? "unstar" : "star")}
          />
          <IconButton
            label={allRead ? t("mail.markUnread") : t("mail.markRead")}
            tooltip={allRead ? t("mail.markUnread") : t("mail.markRead")}
            icon={<Icon icon={allRead ? EnvelopeIcon : EnvelopeOpenIcon} />}
            variant="ghost"
            isDisabled={selected.size === 0}
            isLoading={busy === "read" || busy === "unread"}
            onClick={() => bulk(allRead ? "unread" : "read")}
          />
        </>
      }
      endContent={
        selected.size > 0 && (
          <Text type="supporting" textWrap="nowrap">
            {t("mail.selected", { count: selected.size })}
          </Text>
        )
      }
    />
  );

  const refresh = (
    <Button
      label={t("mail.refresh")}
      icon={<Icon icon={ArrowPathIcon} size="sm" />}
      variant="ghost"
      onClick={() => {
        void reload();
        void refreshCounts();
      }}
    />
  );

  const reader = openId && (
    <Suspense fallback={<ListSkeleton />}>
      <Reader
        key={openId}
        id={openId}
        folder={"search" in query ? "search" : query.folder}
        showBack={!sideBySide}
        isPadded={sideBySide}
        onBack={() => go(null)}
        onAction={onReaderAction}
        onOpened={onOpened}
        busy={busy}
      />
    </Suspense>
  );

  if (!sideBySide && openId) {
    return <PageFrame title={title}>{reader}</PageFrame>;
  }

  return (
    <PageFrame
      title={title}
      actions={refresh}
      toolbar={bulkBar}
      end={
        sideBySide && (
          <LayoutPanel width="58%" hasDivider padding={0} label={t("mail.reader")}>
            {reader || (
              <Center height="100%">
                <EmptyState
                  icon={<Icon icon={EnvelopeOpenIcon} size="lg" color="secondary" />}
                  title={t("mail.nothingOpen")}
                />
              </Center>
            )}
          </LayoutPanel>
        )
      }
    >
      {listBody}
    </PageFrame>
  );
}
