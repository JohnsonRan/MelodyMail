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
import { type Dispatch, type SetStateAction, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type MessageItem, senderName } from "./api";
import { formatListDate } from "./format";

type Row = MessageItem & Record<string, unknown>;

// Wide enough for a short date or a time in each locale ("11月16日", "Nov 16, 2025"), so the
// message column takes the rest of the row.
const DATE_COLUMN = 112;

const OPEN_CELL_STYLE = { backgroundColor: "var(--color-accent-muted)" };

// The row opens the message; its checkbox only selects it. Clicks and keys that start inside
// another control in the row (the selection checkbox) are not the row's own.
const INTERACTIVE = "input, button, a, label, [role='checkbox']";
function isRowItself(event: { target: EventTarget | null; currentTarget: EventTarget }) {
  const target = event.target as Element | null;
  const control = target?.closest(INTERACTIVE);
  return !control || control === event.currentTarget;
}

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
}: {
  messages: MessageItem[];
  openId: string | null;
  onOpen: (item: MessageItem) => void;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  onCursor: (index: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const rows = messages as Row[];
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

  const rowBehaviour = useMemo<TablePlugin<Row>>(
    () => ({
      transformBodyRow: (props, item) => ({
        ...props,
        htmlProps: {
          ...props.htmlProps,
          tabIndex: 0,
          "data-message-row": item.id,
          "aria-current": item.id === openId ? true : undefined,
          onFocus: () => onCursor(messages.indexOf(item)),
          onClick: (event) => {
            if (isRowItself(event)) onOpen(item);
          },
          onKeyDown: (event) => {
            if (event.key !== "Enter" || !isRowItself(event)) return;
            event.preventDefault();
            onOpen(item);
          },
        },
      }),
      transformBodyCell: (props, _column, item) =>
        item.id === openId
          ? {
              ...props,
              htmlProps: {
                ...props.htmlProps,
                style: { ...props.htmlProps.style, ...OPEN_CELL_STYLE },
              },
            }
          : props,
    }),
    [messages, onCursor, onOpen, openId],
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
                  {senderName(item.from)}
                </Text>
              </StackItem>
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
              {item.status === "parsed" && item.snippet ? item.snippet : t("mail.noPreview")}
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
    <Table<Row>
      data={rows}
      columns={columns}
      idKey="id"
      plugins={{ selection, rowStatus, rowBehaviour }}
      density="balanced"
      dividers="rows"
      hasHover
      verticalAlign="top"
    />
  );
}
