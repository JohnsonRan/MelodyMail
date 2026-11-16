import { FileInput } from "@astryxdesign/core/FileInput";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { ExclamationCircleIcon, PaperClipIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { formatSize } from "../mailbox/format";
import type { Entry } from "./useCompose";

/** The attach control and the attached files with upload progress and remove. */
export function AttachmentField({
  entries,
  enabled,
  onAdd,
  onRemove,
}: {
  entries: Entry[];
  /** False while the Worker has no UPLOAD_URL_KEY. */
  enabled: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (entry: Entry) => void;
}) {
  const { t, i18n } = useTranslation("compose");
  return (
    <VStack gap={2} hAlign="stretch">
      <FileInput
        label={t("attach")}
        value={null}
        isMultiple
        isDisabled={!enabled}
        disabledMessage={enabled ? undefined : t("attachmentsOff")}
        description={enabled ? t("attachLimits") : t("attachmentsOff")}
        onChange={(files) => {
          if (files) onAdd(Array.isArray(files) ? files : [files]);
        }}
        width="100%"
      />
      {entries.length > 0 && (
        <List hasDividers>
          {entries.map((entry) => {
            const uploading = !entry.upload && !entry.error;
            return (
              <ListItem
                key={entry.key}
                itemKey={entry.key}
                startContent={
                  <Icon
                    icon={entry.error ? ExclamationCircleIcon : PaperClipIcon}
                    size="sm"
                    color={entry.error ? "error" : "secondary"}
                  />
                }
                label={entry.filename}
                description={
                  entry.error ? (
                    <Text type="supporting">
                      {t(`uploadError.${entry.error}`, { defaultValue: t("uploadError.internal") })}
                    </Text>
                  ) : uploading ? (
                    <ProgressBar
                      label={t("uploading", { name: entry.filename })}
                      isLabelHidden
                      value={entry.progress * 100}
                    />
                  ) : (
                    formatSize(entry.size, i18n.language)
                  )
                }
                endContent={
                  <IconButton
                    label={t("removeAttachment", { name: entry.filename })}
                    tooltip={t("removeAttachment", { name: entry.filename })}
                    icon={<Icon icon={XMarkIcon} />}
                    variant="ghost"
                    size="sm"
                    isDisabled={uploading}
                    onClick={() => onRemove(entry)}
                  />
                }
              />
            );
          })}
        </List>
      )}
    </VStack>
  );
}
