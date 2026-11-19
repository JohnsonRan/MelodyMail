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
import { ACTION_FLAGS, type BulkAction, belongs } from "../mailbox/actions";
import {
  deleteForever,
  type Flags,
  type ListQuery,
  type MessageItem,
  setFlags,
} from "../mailbox/api";
import { BulkBar } from "../mailbox/BulkBar";
import { FolderRow } from "../mailbox/FolderRow";
import { ListBody, ListSkeleton } from "../mailbox/ListBody";
import { useMailbox } from "../mailbox/MailboxContext";
import { rowElement } from "../mailbox/MessageList";
import { useMailShortcuts } from "../mailbox/useMailShortcuts";
import "../mailbox/phone.css";
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

  const { list, reload, applyLocal, sentinel } = useMessageList(query, failed, () => {
    setSelected(new Set());
    setSelecting(false);
    setCursor(0);
  });

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
          list.items.some((m) => ids.includes(m.id) && !belongs({ ...m, ...flags }, query));
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

  const inTrash = "folder" in query && query.folder === "trash";
  const inArchive = "folder" in query && query.folder === "archive";
  const chosen = list.items.filter((m) => selected.has(m.id));

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
          <BulkBar
            count={selected.size}
            inTrash={inTrash}
            inArchive={inArchive}
            allStarred={chosen.length > 0 && chosen.every((m) => m.starred)}
            allRead={chosen.length > 0 && chosen.every((m) => m.read)}
            busy={busy}
            onAction={bulk}
          />
        ) : (
          inTrash && <FolderRow note={t("mail.trashNote")} />
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
          setSelected,
          onCursor: setCursor,
          selectable: !compact || selecting,
          tapSelects: phoneSelecting,
          onLongPress:
            compact && coarse
              ? (item) => {
                  setSelecting(true);
                  setSelected(new Set([item.id]));
                }
              : undefined,
        }}
      />
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
