import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { InboxIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";

export function InboxPage() {
  const { t } = useTranslation();
  return (
    <Center height="100%">
      <EmptyState
        headingLevel={1}
        icon={<Icon icon={InboxIcon} size="lg" color="secondary" />}
        title={t("inbox.emptyTitle")}
        description={t("inbox.emptyDescription")}
      />
    </Center>
  );
}
