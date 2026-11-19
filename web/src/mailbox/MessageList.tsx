import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import {
  pixel,
  proportional,
  Table,
  type TableColumn,
  type TablePlugin,
  useTableRowStatus,
  useTableSelection,
  useTableSelectionState,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { PaperClipIcon, StarIcon } from "@heroicons/react/24/solid";
import {
  type CSSProperties,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import type { SwipeAction, SwipeSide } from "./actions";
import { type MessageItem, senderName } from "./api";
import { formatListDate } from "./format";
import { SendStatusLabel } from "./SendStatusLabel";
import { SwipeBackdrop } from "./SwipeBackdrop";
import { isRowItself, useRowGestures } from "./useRowGestures";

type Row = MessageItem & Record<string, unknown>;

// Wide enough for a short date or a time in each locale ("11月16日", "Nov 16, 2025"), so the
// message column takes the rest of the row.
const DATE_COLUMN = 112;

const NO_SHRINK = { flexShrink: 0 };

// touch-action: pan-y on the cells (it does not apply to a table row) leaves vertical scrolling
// to the browser and keeps horizontal moves for the row's own gestures. The callout would offer
// to copy the row's text on a long press.
const GESTURE_ROW: CSSProperties = { WebkitTouchCallout: "none" };
const GESTURE_CELL: CSSProperties = { touchAction: "pan-y" };

const OPEN_CELL_STYLE = { backgroundColor: "var(--color-accent-muted)" };

// The row opens the message; its checkbox only selects it. Under a coarse pointer the whole
// selection cell, at least TOUCH_TARGET wide, selects: the 24 px box gets a 44 px target
// (REQUIREMENTS.md, "Touch target, coarse pointer") and a near miss does not open the message.
const COARSE = "(pointer: coarse)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const TOUCH_TARGET = 44;
// The selection plugin's column: SELECTION_COLUMN_KEY in Astryx's useTableSelection, which the
// package does not export. The phone suite fails if it changes (web/test/mobile.test.ts).
const SELECTION_COLUMN = "__xds_selection";

function selectFromCell(event: MouseEvent<HTMLElement>) {
  if ((event.target as Element).closest("input")) return;
  event.currentTarget.querySelector<HTMLInputElement>("input[type=checkbox]")?.click();
}
const selectCell = { "data-select-cell": "", onClick: selectFromCell };

export function rowElement(id: string): HTMLElement | null {
  return document.querySelector(`[data-message-row="${CSS.escape(id)}"]`);
}

/**
 * The message list: one row per message with sender, subject, snippet, date, unread marker,
 * star and attachment icon, and a selection checkbox (docs/M4-mailbox.md, "List").
 */
export function MessageList({
  messages,
  openId,
  onOpen,
  selected,
  setSelected,
  onCursor,
  selectable = true,
  tapSelects = false,
  onLongPress,
  swipe,
}: {
  messages: MessageItem[];
  openId: string | null;
  onOpen: (item: MessageItem) => void;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  onCursor: (index: number) => void;
  /** Whether the selection column shows; a phone shows it only in selection mode. */
  selectable?: boolean;
  /** A tap on a row toggles its selection instead of opening it (phone selection mode). */
  tapSelects?: boolean;
  /** A 500 ms press on a row (phone, coarse pointer); without it the row has no gestures. */
  onLongPress?: (item: MessageItem) => void;
  /** Swipe actions by side, and what runs one; without them a row does not swipe. */
  swipe?: {
    actions: Partial<Record<SwipeSide, SwipeAction>>;
    run: (item: MessageItem, action: SwipeAction) => Promise<boolean>;
  };
}) {
  const { t, i18n } = useTranslation();
  const coarse = useMediaQuery(COARSE);
  const rows = messages as Row[];
  const reduceMotion = useMediaQuery(REDUCED_MOTION);
  const host = useRef<HTMLDivElement>(null);
  const { gestures, view } = useRowGestures<MessageItem>({
    enabled: onLongPress !== undefined && !tapSelects,
    onLongPress: (item) => onLongPress?.(item),
    swipe: swipe && {
      actionFor: (_, side) => swipe.actions[side] ?? null,
      run: (item, action) => swipe.run(item, action as SwipeAction),
      reduceMotion,
      host,
    },
  });
  const { selectionConfig } = useTableSelectionState<Row>({
    data: rows,
    idKey: "id",
    selectedKeys: selected,
    setSelectedKeys: setSelected,
  });
  const selection = useTableSelection<Row>({
    ...selectionConfig,
    getRowLabel: (item) => `${senderName(item.from)}: ${item.subject ?? t("mail.noSubject")}`,
    hasRowHighlight: false,
  });
  const rowStatus = useTableRowStatus<Row>({
    getStatus: useCallback(
      (item: Row) => (item.read ? null : { color: "accent" as const, label: t("mail.unread") }),
      [t],
    ),
  });

  const toggle = useCallback(
    (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [setSelected],
  );

  const rowBehaviour = useMemo<TablePlugin<Row>>(
    () => ({
      transformColumns: (columns) =>
        coarse
          ? columns.map((c) =>
              c.key === SELECTION_COLUMN ? { ...c, width: pixel(TOUCH_TARGET) } : c,
            )
          : columns,
      transformHeaderCell: (props, column) =>
        coarse && column.key === SELECTION_COLUMN
          ? {
              ...props,
              htmlProps: {
                ...props.htmlProps,
                ...selectCell,
                style: { ...props.htmlProps.style, height: TOUCH_TARGET },
              },
            }
          : props,
      transformBodyRow: (props, item) => ({
        ...props,
        htmlProps: {
          ...props.htmlProps,
          ...(onLongPress && {
            ...gestures.bind(item),
            style: { ...props.htmlProps.style, ...GESTURE_ROW },
          }),
          tabIndex: 0,
          "data-message-row": item.id,
          "aria-current": item.id === openId ? true : undefined,
          onFocus: () => onCursor(messages.indexOf(item)),
          onClick: (event) => {
            if (gestures.swallowClick() || !isRowItself(event)) return;
            if (tapSelects) toggle(item.id);
            else onOpen(item);
          },
          onKeyDown: (event) => {
            if (event.key !== "Enter" || !isRowItself(event)) return;
            event.preventDefault();
            if (tapSelects) toggle(item.id);
            else onOpen(item);
          },
        },
      }),
      transformBodyCell: (props, column, item) => {
        const htmlProps = { ...props.htmlProps };
        if (item.id === openId) htmlProps.style = { ...htmlProps.style, ...OPEN_CELL_STYLE };
        if (onLongPress) htmlProps.style = { ...htmlProps.style, ...GESTURE_CELL };
        if (coarse && column.key === SELECTION_COLUMN) Object.assign(htmlProps, selectCell);
        return { ...props, htmlProps };
      },
    }),
    [coarse, gestures, messages, onCursor, onLongPress, onOpen, openId, tapSelects, toggle],
  );

  const columns = useMemo<TableColumn<Row>[]>(
    () => [
      {
        key: "message",
        header: t("mail.message"),
        width: proportional(1, { minWidth: 160 }),
        renderCell: (item) => (
          <VStack gap={0.5}>
            <HStack gap={1} vAlign="center">
              <StackItem size="fill">
                <Text maxLines={1} weight={item.read ? "normal" : "semibold"}>
                  {item.direction === "out"
                    ? t("mail.toLine", { to: item.to ?? "" })
                    : senderName(item.from)}
                </Text>
              </StackItem>
              {item.direction === "out" && (
                // The status keeps its width; the recipients are cut instead.
                <StackItem style={NO_SHRINK}>
                  <SendStatusLabel status={item.status} />
                </StackItem>
              )}
              {item.hasAttachments && (
                <Icon
                  icon={PaperClipIcon}
                  size="sm"
                  color="secondary"
                  label={t("mail.hasAttachments")}
                />
              )}
              {item.starred && (
                <Icon icon={StarIcon} size="sm" color="accent" label={t("mail.starred")} />
              )}
            </HStack>
            <Text maxLines={1} weight={item.read ? "normal" : "semibold"}>
              {item.subject || t("mail.noSubject")}
            </Text>
            <Text maxLines={1} type="supporting" color="secondary">
              {(item.status === "parsed" || item.direction === "out") && item.snippet
                ? item.snippet
                : t("mail.noPreview")}
            </Text>
          </VStack>
        ),
      },
      {
        key: "date",
        header: t("mail.date"),
        width: pixel(DATE_COLUMN),
        align: "end",
        renderCell: (item) => (
          <Text type="supporting" textWrap="nowrap" hasTabularNumbers>
            {formatListDate(item.receivedAt, i18n.language)}
          </Text>
        ),
      },
    ],
    [i18n.language, t],
  );

  return (
    <div ref={host} className="mail-swipe-host">
      {view && <SwipeBackdrop view={view} />}
      <Table<Row>
        data={rows}
        columns={columns}
        idKey="id"
        plugins={selectable ? { selection, rowStatus, rowBehaviour } : { rowStatus, rowBehaviour }}
        density="balanced"
        dividers="rows"
        hasHover
        verticalAlign="top"
      />
    </div>
  );
}
