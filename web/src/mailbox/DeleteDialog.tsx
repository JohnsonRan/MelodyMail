import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useTranslation } from "react-i18next";
import type { DeletableFolder } from "./api";
import type { DeleteRequest } from "./useFolderRuns";

/**
 * The confirmation of Delete forever on several messages and of Empty Trash / Empty Spam: the
 * count, "This cannot be undone", then the progress while the calls run. Cancel stops the loop
 * between calls; what was deleted stays deleted.
 */
export function DeleteDialog({
  folder,
  request,
  done,
  onConfirm,
  onCancel,
}: {
  folder: DeletableFolder;
  request: DeleteRequest | null;
  /** Deleted so far while the loop runs; null before it starts. */
  done: number | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const total = request?.total ?? 0;
  const empty = request?.kind === "empty";
  const title = empty
    ? t(folder === "trash" ? "mail.emptyTrashTitle" : "mail.emptySpamTitle")
    : t("mail.deleteManyTitle", { count: total });
  return (
    <AlertDialog
      isOpen={request !== null}
      onOpenChange={(open) => !open && onCancel()}
      title={title}
      description={
        done === null
          ? t("mail.deleteManyDescription", { count: total })
          : t("mail.deleteProgress", { done, total })
      }
      actionLabel={
        empty
          ? t(folder === "trash" ? "mail.emptyTrash" : "mail.emptySpam")
          : t("mail.deleteForever")
      }
      cancelLabel={done === null ? t("common.cancel") : t("mail.stop")}
      isActionLoading={done !== null}
      onAction={onConfirm}
    />
  );
}
