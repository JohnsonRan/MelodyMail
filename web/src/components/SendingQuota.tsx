import { VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading } from "@astryxdesign/core/Text";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getQuota, type Quota } from "../compose/api";
import { QuotaLine } from "../compose/QuotaLine";

/** Settings > Domains: the Resend quota as last reported (docs/M5-sending.md, "Screens"). */
export function SendingQuota() {
  const { t } = useTranslation();
  const [quota, setQuota] = useState<Quota | null | "failed">(null);
  useEffect(() => {
    getQuota()
      .then(setQuota)
      .catch(() => setQuota("failed"));
  }, []);
  if (quota === "failed") return null;
  return (
    <VStack gap={2}>
      <Heading level={2}>{t("settings.quotaTitle")}</Heading>
      {quota ? <QuotaLine quota={quota} /> : <Skeleton height="var(--size-control-sm)" />}
    </VStack>
  );
}
