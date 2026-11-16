import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Layout";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNetwork } from "../network";
import { useWaitingUpdate } from "../pwa/status";

/**
 * App-wide states above the page: offline (docs/M4b-pwa.md, "Offline state") and a waiting app
 * update. Nothing renders while neither applies.
 */
export function SystemBanners({ container = "section" }: { container?: "card" | "section" }) {
  const { t } = useTranslation();
  const { offline } = useNetwork();
  const update = useWaitingUpdate();
  const [reloading, setReloading] = useState(false);
  if (!offline && !update) return null;
  return (
    <VStack gap={0} hAlign="stretch">
      {offline && (
        <Banner
          status="warning"
          container={container}
          title={t("system.offlineTitle")}
          description={t("system.offlineDescription")}
        />
      )}
      {update && (
        <Banner
          status="info"
          container={container}
          title={t("system.updateTitle")}
          description={t("system.updateDescription")}
          endContent={
            <Button
              label={t("system.reload")}
              variant="secondary"
              size="sm"
              isLoading={reloading}
              onClick={() => {
                setReloading(true);
                void update();
              }}
            />
          }
        />
      )}
    </VStack>
  );
}
