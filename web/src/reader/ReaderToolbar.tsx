import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  EnvelopeIcon,
  InboxArrowDownIcon,
  MoonIcon,
  PhotoIcon,
  ArrowUturnLeftIcon as ReplyIcon,
  StarIcon as StarOutline,
  TrashIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";
import type { SourceKind } from "../compose/api";
import type { MessageDetail } from "../mailbox/api";

const COMPOSE_ACTIONS: { kind: SourceKind; icon: typeof ReplyIcon }[] = [
  { kind: "reply", icon: ReplyIcon },
  { kind: "replyAll", icon: UsersIcon },
  { kind: "forward", icon: ArrowUturnRightIcon },
];

export type ReaderAction =
  | "archive"
  | "unarchive"
  | "trash"
  | "restore"
  | "star"
  | "unstar"
  | "unread"
  | "delete";

/** The reader's action row for the open message. */
export function ReaderToolbar({
  current,
  inTrash,
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
          {current &&
            COMPOSE_ACTIONS.map(({ kind, icon }) => (
              <IconButton
                key={kind}
                label={t(`mail.${kind}`)}
                tooltip={t(`mail.${kind}`)}
                icon={<Icon icon={icon} />}
                variant="ghost"
                onClick={() => onCompose(kind)}
              />
            ))}
          {current && !inTrash && (
            <IconButton
              label={current.archived ? t("mail.moveToInbox") : t("mail.archive")}
              tooltip={current.archived ? t("mail.moveToInbox") : t("mail.archive")}
              icon={<Icon icon={current.archived ? InboxArrowDownIcon : ArchiveBoxIcon} />}
              variant="ghost"
              isLoading={busy === "archive" || busy === "unarchive"}
              onClick={() => run(current.archived ? "unarchive" : "archive")}
            />
          )}
          {current && (
            <IconButton
              label={inTrash ? t("mail.restore") : t("mail.trash")}
              tooltip={inTrash ? t("mail.restore") : t("mail.trash")}
              icon={<Icon icon={inTrash ? ArrowUturnLeftIcon : TrashIcon} />}
              variant="ghost"
              isLoading={busy === "trash" || busy === "restore"}
              onClick={() => run(inTrash ? "restore" : "trash")}
            />
          )}
          {current && (
            <IconButton
              label={current.starred ? t("mail.unstar") : t("mail.star")}
              tooltip={current.starred ? t("mail.unstar") : t("mail.star")}
              icon={<Icon icon={current.starred ? StarIcon : StarOutline} />}
              variant="ghost"
              isLoading={busy === "star" || busy === "unstar"}
              onClick={() => run(current.starred ? "unstar" : "star")}
            />
          )}
          {current && (
            <IconButton
              label={t("mail.markUnread")}
              tooltip={t("mail.markUnread")}
              icon={<Icon icon={EnvelopeIcon} />}
              variant="ghost"
              isLoading={busy === "unread"}
              onClick={() => run("unread")}
            />
          )}
          {current && canShowRemote && (
            <IconButton
              label={t("mail.showRemoteImages")}
              tooltip={t("mail.showRemoteImages")}
              icon={<Icon icon={PhotoIcon} />}
              variant="ghost"
              onClick={onShowRemote}
            />
          )}
          {current && darkReading !== null && (
            <ToggleButton
              label={t("mail.darkReading")}
              icon={<Icon icon={MoonIcon} />}
              isIconOnly
              isPressed={darkReading}
              onPressedChange={onDarkReading}
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
            onClick={onDelete}
          />
        )
      }
    />
  );
}
