import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import type { Quota } from "./api";

// The Resend quota as last reported (docs/M5-sending.md, "Screens"): a warning from 80% of
// either limit; the Send button explains when today's quota is used up.

export const QUOTA_WARNING = 0.8;

export type QuotaLevel = "ok" | "warning" | "dailyUsed" | "monthlyUsed";

export function quotaLevel(quota: Quota | null): QuotaLevel {
  if (!quota) return "ok";
  const { daily, monthly } = quota;
  if (monthly.limit > 0 && monthly.used >= monthly.limit) return "monthlyUsed";
  if (daily.limit > 0 && daily.used >= daily.limit) return "dailyUsed";
  const share = Math.max(daily.used / (daily.limit || 1), monthly.used / (monthly.limit || 1));
  return share >= QUOTA_WARNING ? "warning" : "ok";
}

export function QuotaLine({ quota }: { quota: Quota }) {
  const { t, i18n } = useTranslation();
  const n = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const level = quotaLevel(quota);
  const text = t("quota.line", {
    daily: n(quota.daily.used),
    dailyLimit: n(quota.daily.limit),
    monthly: n(quota.monthly.used),
    monthlyLimit: n(quota.monthly.limit),
  });
  if (level === "ok") {
    return (
      <Text type="supporting" color="secondary" textWrap="nowrap">
        {text}
      </Text>
    );
  }
  const color = level === "warning" ? "warning" : "error";
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      <Icon icon={ExclamationTriangleIcon} size="sm" color={color} />
      <Text type="supporting">
        {text} · {t(`quota.${level}`)}
      </Text>
    </HStack>
  );
}
