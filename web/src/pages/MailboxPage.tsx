import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { LayoutPanel } from "@astryxdesign/core/Layout";
import { useToast } from "@astryxdesign/core/Toast";
import { ArrowPathIcon, EnvelopeOpenIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import { NARROW } from "../breakpoints";
import { PageFrame } from "../components/PageFrame";
import { ComposeSlot, useComposeRoute } from "../compose/route";
import { errorMessage } from "../errors";
import {
  ACTION_FLAGS,
  type BulkAction,
  belongs,
  swipeActions,
  withFlags,
} from "../mailbox/actions";
import {
  type DeletableFolder,
  deleteForever,
  type Flags,
  type ListQuery,
  type MessageItem,
  setFlags,
} from "../mailbox/api";
import { BulkBar } from "../mailbox/BulkBar";
import { DeleteDialog } from "../mailbox/DeleteDialog";
import { FolderRow } from "../mailbox/FolderRow";
import { ListBody, ListSkeleton } from "../mailbox/ListBody";
import { useMailbox } from "../mailbox/MailboxContext";
import { rowElement } from "../mailbox/MessageList";
import { useMailShortcuts } from "../mailbox/useMailShortcuts";
import "../mailbox/phone.css";
import { SelectAllBanner } from "../mailbox/SelectAllBanner";
import { useFolderRuns } from "../mailbox/useFolderRuns";
import { useMessageList } from "../mailbox/useMessageList";
import type { ReaderAction } from "../reader/ReaderToolbar";

// The reader, postal-mime and DOMPurify load only when a message is opened.
const Reader = lazy(() => import("../reader/Reader"));

// At laptop width and wider the list and the reader sit side by side; below it, one pane at a
// time (docs/M4-mailbox.md, "Layout by width"; REQUIREMENTS.md, supported widths).
const SIDE_BY_SIDE = "(min-width: 1280px)";
const COARSE = "(pointer: coarse)";

const NOTICES: Record<string, string> = {
  archive: "archived",
  trash: "trashed",
  restore: "restored",
  delete: "deleted",
  reportSpam: "spammed",
  notSpam: "notSpam",
};

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
  const compose = useComposeRoute();
  const { refreshCounts } = useMailbox();
  const compact = useMediaQuery(NARROW);
  const coarse = useMediaQuery(COARSE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Phone selection mode: the bulk bar and the row checkboxes show only while it is on.
  const [selecting, setSelecting] = useState(false);
  const hadSelection = useRef(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);

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

  // A change of folder, address or search, or a reload, leaves whole-folder mode and stops a loop.
  const resetRuns = useRef(() => {});
  const { list, reload, applyLocal, exclusive, sentinel } = useMessageList(query, failed, () => {
    setSelected(new Set());
    setSelecting(false);
    setCursor(0);
    resetRuns.current();
  });

  const view = "folder" in query ? query : null;
  const runs = useFolderRuns({
    view,
    // "Select all N" covers folders, not search results (owner ruling 4).
    eligible:
      view !== null &&
      list.next !== null &&
      list.items.length > 0 &&
      list.items.every((m) => selected.has(m.id)),
    running,
    exclusive,
    applyLocal,
    failed,
    refreshCounts,
    onDeleted: useCallback(
      (ids: string[]) => {
        if (openId && ids.includes(openId)) go(null);
        setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      },
      [go, openId],
    ),
  });
  resetRuns.current = runs.reset;

  // Clearing the last selected row leaves selection mode.
  useEffect(() => {
    if (selected.size > 0) hadSelection.current = true;
    else if (hadSelection.current) {
      hadSelection.current = false;
      setSelecting(false);
    }
  }, [selected]);

  const leaveSelecting = () => {
    hadSelection.current = false;
    setSelecting(false);
    setSelected(new Set());
  };

  const phoneSelecting = compact && selecting;
  // Swipe actions are a phone convenience: each duplicates a toolbar action (M8 decision 4).
  const swipes = swipeActions(query);
  const swipeOn = compact && coarse && !phoneSelecting && Object.keys(swipes).length > 0;

  /** Runs one action at a time on `ids`; resolves true when it succeeded. */
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
          list.items.some((m) => ids.includes(m.id) && !belongs(withFlags(m, flags), query));
        if (leaves && openId && ids.includes(openId)) go(null);
        if (leaves) setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
        const notice = NOTICES[name];
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

  const refresh = () => {
    void reload();
    void refreshCounts();
  };

  const folder = view?.folder ?? "search";
  const inTrash = folder === "trash";
  const inArchive = folder === "archive";
  const deletable: DeletableFolder | null = folder === "trash" || folder === "spam" ? folder : null;
  const chosen = list.items.filter((m) => selected.has(m.id));

  const bulk = async (action: BulkAction) => {
    const flags = action === "read" ? { read: true } : ACTION_FLAGS[action];
    if (!runs.whole) {
      void act(action, [...selected], flags);
      return;
    }
    setBusy(action);
    const done = await runs.changeWhole(flags);
    setBusy(null);
    setSelected(new Set());
    const notice = NOTICES[action];
    if (notice && done > 0) toast({ body: t(`mail.done.${notice}`, { count: done }) });
  };

  /** Unchecking a row leaves whole-folder mode (docs/M8-mailbox-ux.md, section 2). */
  const select: typeof setSelected = (update) => {
    const next = typeof update === "function" ? update(selected) : update;
    if (runs.whole && [...selected].some((id) => !next.has(id))) runs.leaveWhole();
    setSelected(next);
  };

  // Trash and Spam say when their mail is deleted, and offer Empty while they hold any.
  const folderNote = deletable && (
    <FolderRow note={t(deletable === "trash" ? "mail.trashNote" : "mail.spamNote")}>
      {list.status === "ready" && list.items.length > 0 && (
        <Button
          label={t(deletable === "trash" ? "mail.emptyTrash" : "mail.emptySpam")}
          variant="secondary"
          size="sm"
          isLoading={runs.counting}
          isDisabled={runs.looping}
          onClick={() => void runs.askEmpty()}
        />
      )}
    </FolderRow>
  );

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
    compose: () => compose.open(),
    reply: () => openId && compose.open({ id: openId, kind: "reply" }),
    replyAll: () => openId && compose.open({ id: openId, kind: "replyAll" }),
    forward: () => openId && compose.open({ id: openId, kind: "forward" }),
  });

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
        onCompose={(kind, message) => compose.open({ id: message.id, kind })}
        busy={busy}
      />
    </Suspense>
  );

  const composer = compose.composeId && (
    <ComposeSlot
      draftId={compose.composeId}
      source={compose.source}
      onClose={compose.close}
      isPanel={sideBySide}
    />
  );

  // As a page, compose draws its own frame with Close and Send in the title row.
  if (!sideBySide && composer) return composer;
  if (!sideBySide && openId) {
    return <PageFrame title={title}>{reader}</PageFrame>;
  }

  return (
    <PageFrame
      title={title}
      actions={
        compact ? (
          <>
            <IconButton
              label={t("mail.refresh")}
              icon={<Icon icon={ArrowPathIcon} />}
              variant="ghost"
              isDisabled={runs.looping}
              onClick={refresh}
            />
            <Button
              label={selecting ? t("mail.selectDone") : t("mail.select")}
              variant="ghost"
              onClick={() => (selecting ? leaveSelecting() : setSelecting(true))}
            />
          </>
        ) : (
          <>
            <Button
              label={t("mail.refresh")}
              icon={<Icon icon={ArrowPathIcon} size="sm" />}
              variant="ghost"
              isDisabled={runs.looping}
              onClick={refresh}
            />
            <Button
              label={t("mail.compose")}
              icon={<Icon icon={PencilSquareIcon} size="sm" />}
              variant="primary"
              onClick={() => compose.open()}
            />
          </>
        )
      }
      toolbar={
        !compact || phoneSelecting ? (
          <>
            <BulkBar
              count={runs.whole ? runs.whole.total : selected.size}
              folder={folder}
              whole={runs.whole !== null}
              allStarred={chosen.length > 0 && chosen.every((m) => m.starred)}
              allRead={chosen.length > 0 && chosen.every((m) => m.read)}
              busy={busy}
              onAction={(action) => void bulk(action)}
              onDeleteForever={() => runs.askDelete([...selected])}
              idle={folderNote}
            />
            <SelectAllBanner
              folderName={title}
              loaded={list.items.length}
              offer={runs.offer}
              whole={runs.whole}
              progress={runs.request ? null : runs.progress}
              onSelectAll={runs.selectWhole}
              onClear={() => {
                runs.leaveWhole();
                setSelected(new Set());
              }}
              onStop={runs.stopLoop}
            />
          </>
        ) : (
          folderNote
        )
      }
      end={
        sideBySide && (
          <LayoutPanel width="58%" hasDivider padding={0} label={t("mail.reader")}>
            {composer || reader || (
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
      <ListBody
        query={query}
        list={list}
        sentinel={sentinel}
        onRetry={() => void reload()}
        rows={{
          openId,
          onOpen: (item) => go(item.id),
          selected,
          setSelected: select,
          onCursor: setCursor,
          selectable: !compact || selecting,
          // A phone row needs no "Message / Date" header; in selection mode it holds select all.
          hasHeader: !compact || phoneSelecting,
          tapSelects: phoneSelecting,
          onLongPress:
            compact && coarse
              ? (item) => {
                  setSelecting(true);
                  setSelected(new Set([item.id]));
                }
              : undefined,
          swipe: swipeOn
            ? {
                actions: swipes,
                run: (item, action) => act(action, [item.id], ACTION_FLAGS[action]),
              }
            : undefined,
        }}
      />
      {deletable && (
        <DeleteDialog
          folder={deletable}
          request={runs.request}
          done={runs.request && runs.progress ? runs.progress.done : null}
          onConfirm={() => void runs.confirmDelete()}
          onCancel={runs.cancelDelete}
        />
      )}
      {compact && !phoneSelecting && (
        <>
          <div className="mail-compose-gap" />
          <div className="mail-compose-fab">
            <Button
              label={t("mail.compose")}
              icon={<Icon icon={PencilSquareIcon} size="sm" />}
              variant="primary"
              size="lg"
              onClick={() => compose.open()}
            />
          </div>
        </>
      )}
    </PageFrame>
  );
}
