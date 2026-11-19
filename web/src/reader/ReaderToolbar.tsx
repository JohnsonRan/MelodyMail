import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from "@astryxdesign/core/DropdownMenu";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon,
  InboxArrowDownIcon,
  MoonIcon,
  PhotoIcon,
  ArrowUturnLeftIcon as ReplyIcon,
  ShieldExclamationIcon,
  StarIcon as StarOutline,
  TrashIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";
import { NARROW } from "../breakpoints";
import type { SourceKind } from "../compose/api";
import type { MessageDetail } from "../mailbox/api";

export type ReaderAction =
  | "archive"
  | "unarchive"
  | "trash"
  | "restore"
  | "star"
  | "unstar"
  | "unread"
  | "reportSpam"
  | "notSpam"
  | "delete";

type Action = {
  key: string;
  label: string;
  icon: typeof ReplyIcon;
  onClick: () => void;
  isLoading?: boolean;
  /** Shown as an icon on a phone too; the rest go to the More menu there. */
  isCommon?: boolean;
};

/**
 * The reader's action row for the open message. On a phone only the common actions are icons
 * and the rest sit in a More menu with text labels, as in the Gmail and Outlook apps. In Spam,
 * Not spam takes the place of Archive and Move to Trash; elsewhere received mail can be reported.
 */
export function ReaderToolbar({
  current,
  inTrash,
  inSpam,
  showBack,
  onBack,
  busy,
  run,
  canShowRemote,
  onShowRemote,
  onDelete,
  darkReading,
  onDarkReading,
  onCompose,
}: {
  current: MessageDetail | undefined;
  inTrash: boolean;
  inSpam: boolean;
  showBack: boolean;
  onBack: () => void;
  busy: string | null;
  run: (action: ReaderAction) => void;
  /** The open message has blocked remote images the owner can still allow. */
  canShowRemote: boolean;
  onShowRemote: () => void;
  onDelete: () => void;
  /** Whether dark reading is on; null hides the toggle (light theme, or no HTML body). */
  darkReading: boolean | null;
  onDarkReading: (on: boolean) => void;
  onCompose: (kind: SourceKind) => void;
}) {
  const { t } = useTranslation();
  const compact = useMediaQuery(NARROW);
  const compose = (kind: SourceKind, icon: typeof ReplyIcon, isCommon = false): Action => ({
    key: kind,
    label: t(`mail.${kind}`),
    icon,
    onClick: () => onCompose(kind),
    isCommon,
  });
  const actions: Action[] = current
    ? [
        compose("reply", ReplyIcon, true),
        compose("replyAll", UsersIcon),
        compose("forward", ArrowUturnRightIcon),
        ...(inSpam
          ? [
              {
                key: "notSpam",
                label: t("mail.notSpam"),
                icon: InboxArrowDownIcon,
                onClick: () => run("notSpam"),
                isLoading: busy === "notSpam",
                isCommon: true,
              },
            ]
          : []),
        ...(inTrash || inSpam
          ? []
          : [
              {
                key: "archive",
                label: current.archived ? t("mail.moveToInbox") : t("mail.archive"),
                icon: current.archived ? InboxArrowDownIcon : ArchiveBoxIcon,
                onClick: () => run(current.archived ? "unarchive" : "archive"),
                isLoading: busy === "archive" || busy === "unarchive",
                isCommon: true,
              },
            ]),
        ...(inSpam
          ? []
          : [
              {
                key: "trash",
                label: inTrash ? t("mail.restore") : t("mail.trash"),
                icon: inTrash ? ArrowUturnLeftIcon : TrashIcon,
                onClick: () => run(inTrash ? "restore" : "trash"),
                isLoading: busy === "trash" || busy === "restore",
                isCommon: true,
              },
            ]),
        {
          key: "star",
          label: current.starred ? t("mail.unstar") : t("mail.star"),
          icon: current.starred ? StarIcon : StarOutline,
          onClick: () => run(current.starred ? "unstar" : "star"),
          isLoading: busy === "star" || busy === "unstar",
        },
        {
          key: "unread",
          label: t("mail.markUnread"),
          icon: EnvelopeIcon,
          onClick: () => run("unread"),
          isLoading: busy === "unread",
        },
        // Never for mail you sent (it cannot enter Spam) nor in Trash, whose actions are Restore
        // and Delete forever.
        ...(inTrash || inSpam || current.direction !== "in"
          ? []
          : [
              {
                key: "reportSpam",
                label: t("mail.reportSpam"),
                icon: ShieldExclamationIcon,
                onClick: () => run("reportSpam"),
                isLoading: busy === "reportSpam",
              },
            ]),
        ...(canShowRemote
          ? [
              {
                key: "remote",
                label: t("mail.showRemoteImages"),
                icon: PhotoIcon,
                onClick: onShowRemote,
              },
            ]
          : []),
      ]
    : [];
  const shown = compact ? actions.filter((a) => a.isCommon) : actions;
  const more = compact ? actions.filter((a) => !a.isCommon) : [];
  return (
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
          {shown.map((a) => (
            <IconButton
              key={a.key}
              label={a.label}
              tooltip={a.label}
              icon={<Icon icon={a.icon} />}
              variant="ghost"
              isLoading={a.isLoading}
              onClick={a.onClick}
            />
          ))}
          {current && !compact && darkReading !== null && (
            <ToggleButton
              label={t("mail.darkReading")}
              icon={<Icon icon={MoonIcon} />}
              isIconOnly
              isPressed={darkReading}
              onPressedChange={onDarkReading}
            />
          )}
          {current && compact && (
            // Children, not items: Dark reading is a checkbox row whose state a screen reader
            // hears. Astryx renders compound children as a popover only, not a bottom sheet.
            <DropdownMenu
              alignment="end"
              renderTrigger={(props) => (
                <IconButton
                  {...props}
                  label={t("mail.moreActions")}
                  icon={<Icon icon={EllipsisHorizontalIcon} />}
                  variant="ghost"
                />
              )}
            >
              {more.map((a) => (
                <DropdownMenuItem key={a.key} label={a.label} icon={a.icon} onClick={a.onClick} />
              ))}
              {darkReading !== null && (
                <DropdownMenuCheckboxItem
                  label={t("mail.darkReading")}
                  icon={MoonIcon}
                  value={darkReading}
                  onChange={onDarkReading}
                />
              )}
            </DropdownMenu>
          )}
        </>
      }
      endContent={
        current &&
        (inTrash || inSpam) && (
          <IconButton
            label={t("mail.deleteForever")}
            tooltip={t("mail.deleteForever")}
            icon={<Icon icon={TrashIcon} />}
            variant="destructive"
            onClick={onDelete}
          />
        )
      }
    />
  );
}
