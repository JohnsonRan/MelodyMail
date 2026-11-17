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
  StarIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { NARROW } from "../breakpoints";
import type { BulkAction } from "./actions";

/**
 * The actions on the selected rows, always shown so the list does not move on selection. In Trash
 * the end of the bar says when mail there is deleted, until rows are selected. On a phone, star
 * and read state sit in a More menu with text labels, as in the reader.
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
  const compact = useMediaQuery(NARROW);
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
                  isLoading={["star", "unstar", "read", "unread"].includes(busy ?? "")}
                />
              )}
              items={[
                allStarred
                  ? { label: t("mail.unstar"), icon: StarIcon, onClick: () => onAction("unstar") }
                  : { label: t("mail.star"), icon: StarIcon, onClick: () => onAction("star") },
                allRead
                  ? {
                      label: t("mail.markUnread"),
                      icon: EnvelopeIcon,
                      onClick: () => onAction("unread"),
                    }
                  : {
                      label: t("mail.markRead"),
                      icon: EnvelopeOpenIcon,
                      onClick: () => onAction("read"),
                    },
              ]}
            />
          ) : (
            <>
              {allStarred
                ? button("unstar", t("mail.unstar"), StarIcon, ["star", "unstar"])
                : button("star", t("mail.star"), StarIcon, ["star", "unstar"])}
              {allRead
                ? button("unread", t("mail.markUnread"), EnvelopeIcon, ["read", "unread"])
                : button("read", t("mail.markRead"), EnvelopeOpenIcon, ["read", "unread"])}
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
          inTrash && <Text type="supporting">{t("mail.trashNote")}</Text>
        )
      }
    />
  );
}
