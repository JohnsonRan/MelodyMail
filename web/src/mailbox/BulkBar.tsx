import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  InboxArrowDownIcon,
  StarIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import type { BulkAction } from "./actions";

/**
 * The actions on the selected rows, always shown so the list does not move on selection. In Trash
 * the end of the bar says when mail there is deleted, until rows are selected.
 */
export function BulkBar({
  count,
  inTrash,
  inArchive,
  allStarred,
  allRead,
  busy,
  onAction,
}: {
  count: number;
  inTrash: boolean;
  inArchive: boolean;
  allStarred: boolean;
  allRead: boolean;
  busy: string | null;
  onAction: (action: BulkAction) => void;
}) {
  const { t } = useTranslation();
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
  return (
    <Toolbar
      label={t("mail.listActions")}
      startContent={
        <>
          {!inTrash &&
            (inArchive
              ? button("unarchive", t("mail.moveToInbox"), InboxArrowDownIcon)
              : button("archive", t("mail.archive"), ArchiveBoxIcon))}
          {inTrash
            ? button("restore", t("mail.restore"), ArrowUturnLeftIcon)
            : button("trash", t("mail.trash"), TrashIcon)}
          {allStarred
            ? button("unstar", t("mail.unstar"), StarIcon, ["star", "unstar"])
            : button("star", t("mail.star"), StarIcon, ["star", "unstar"])}
          {allRead
            ? button("unread", t("mail.markUnread"), EnvelopeIcon, ["read", "unread"])
            : button("read", t("mail.markRead"), EnvelopeOpenIcon, ["read", "unread"])}
        </>
      }
      endContent={
        count > 0 ? (
          <Text type="supporting" textWrap="nowrap">
            {t("mail.selected", { count })}
          </Text>
        ) : (
          inTrash && <Text type="supporting">{t("mail.trashNote")}</Text>
        )
      }
    />
  );
}
