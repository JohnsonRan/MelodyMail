import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  InboxArrowDownIcon,
  ShieldExclamationIcon,
  StarIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NARROW } from "../breakpoints";
import type { BulkAction } from "./actions";
import type { Folder } from "./api";

type MenuItem = { label: string; icon: typeof StarIcon; onClick: () => void };

/**
 * The actions on the selected rows, always shown on desktop so the list does not move on
 * selection. Trash has Restore and Delete forever, Spam has Not spam and Delete forever, and the
 * other folders Report spam (never Sent). Until rows are selected the end of the bar shows `idle`
 * (Trash and Spam: the 30-day note and Empty). On a phone, star, read state and Report spam sit
 * in a More menu with text labels, as in the reader. In whole-folder mode Report spam is labelled
 * Move to Spam: it remembers no sender (docs/M8-mailbox-ux.md, "Filing").
 */
export function BulkBar({
  count,
  folder,
  whole,
  allStarred,
  allRead,
  busy,
  onAction,
  onDeleteForever,
  idle,
}: {
  count: number;
  folder: Folder | "search";
  whole: boolean;
  allStarred: boolean;
  allRead: boolean;
  busy: string | null;
  onAction: (action: BulkAction) => void;
  onDeleteForever: () => void;
  idle?: ReactNode;
}) {
  const { t } = useTranslation();
  const compact = useMediaQuery(NARROW);
  const inTrash = folder === "trash";
  const inSpam = folder === "spam";
  const button = (
    action: BulkAction,
    label: string,
    icon: typeof StarIcon,
    loading: BulkAction[] = [action],
  ) => (
    <IconButton
      label={label}
      tooltip={label}
      icon={<Icon icon={icon} />}
      variant="ghost"
      isDisabled={count === 0}
      isLoading={loading.includes(busy as BulkAction)}
      onClick={() => onAction(action)}
    />
  );
  const spamLabel = whole ? t("mail.moveToSpam") : t("mail.reportSpam");
  const canReport = !inTrash && !inSpam && folder !== "sent";
  const more: MenuItem[] = [
    allStarred
      ? { label: t("mail.unstar"), icon: StarIcon, onClick: () => onAction("unstar") }
      : { label: t("mail.star"), icon: StarIcon, onClick: () => onAction("star") },
    allRead
      ? { label: t("mail.markUnread"), icon: EnvelopeIcon, onClick: () => onAction("unread") }
      : { label: t("mail.markRead"), icon: EnvelopeOpenIcon, onClick: () => onAction("read") },
    ...(canReport
      ? [{ label: spamLabel, icon: ShieldExclamationIcon, onClick: () => onAction("reportSpam") }]
      : []),
  ];
  return (
    <Toolbar
      label={t("mail.listActions")}
      startContent={
        <>
          {inSpam && button("notSpam", t("mail.notSpam"), InboxArrowDownIcon)}
          {!inTrash &&
            !inSpam &&
            (folder === "archive"
              ? button("unarchive", t("mail.moveToInbox"), InboxArrowDownIcon)
              : button("archive", t("mail.archive"), ArchiveBoxIcon))}
          {inTrash && button("restore", t("mail.restore"), ArrowUturnLeftIcon)}
          {!inTrash && !inSpam && button("trash", t("mail.trash"), TrashIcon)}
          {(inTrash || inSpam) && (
            <IconButton
              label={t("mail.deleteForever")}
              tooltip={t("mail.deleteForever")}
              icon={<Icon icon={TrashIcon} />}
              variant="ghost"
              isDisabled={count === 0}
              isLoading={busy === "delete"}
              onClick={onDeleteForever}
            />
          )}
          {compact ? (
            <DropdownMenu
              presentation="adaptive"
              renderTrigger={(props) => (
                <IconButton
                  {...props}
                  label={t("mail.moreActions")}
                  icon={<Icon icon={EllipsisHorizontalIcon} />}
                  variant="ghost"
                  isDisabled={count === 0}
                  isLoading={["star", "unstar", "read", "unread", "reportSpam"].includes(
                    busy ?? "",
                  )}
                />
              )}
              items={more}
            />
          ) : (
            <>
              {allStarred
                ? button("unstar", t("mail.unstar"), StarIcon, ["star", "unstar"])
                : button("star", t("mail.star"), StarIcon, ["star", "unstar"])}
              {allRead
                ? button("unread", t("mail.markUnread"), EnvelopeIcon, ["read", "unread"])
                : button("read", t("mail.markRead"), EnvelopeOpenIcon, ["read", "unread"])}
              {canReport && button("reportSpam", spamLabel, ShieldExclamationIcon)}
            </>
          )}
        </>
      }
      endContent={
        count > 0 ? (
          <Text type="supporting" textWrap="nowrap">
            {t("mail.selected", { count })}
          </Text>
        ) : (
          idle
        )
      }
    />
  );
}
