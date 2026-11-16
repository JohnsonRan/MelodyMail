import { Badge } from "@astryxdesign/core/Badge";
import { Text } from "@astryxdesign/core/Text";
import { useTranslation } from "react-i18next";
import type { MessageItem } from "./api";

// The delivery status of a sent message (docs/M5-sending.md, "Screens"). Only the states that
// need attention get a badge (Astryx Badge guidance); the rest are plain supporting text.

const ATTENTION: Partial<Record<string, "warning" | "error">> = {
  delayed: "warning",
  bounced: "error",
  complained: "error",
  failed: "error",
  suppressed: "error",
};

export function SendStatusLabel({ status }: { status: MessageItem["status"] }) {
  const { t } = useTranslation();
  const variant = ATTENTION[status];
  const label = t(`mail.sendStatus.${status}`, { defaultValue: status });
  if (variant) return <Badge variant={variant} label={label} />;
  return (
    <Text type="supporting" color="secondary" textWrap="nowrap">
      {label}
    </Text>
  );
}
