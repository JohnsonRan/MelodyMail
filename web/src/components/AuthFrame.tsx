import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PreferenceSelectors } from "../preferences";
import { AppLogo } from "./AppLogo";
import { SystemBanners } from "./SystemBanners";

// From the Astryx login-card template: the page paints its own body background, and the column
// is capped at the template's readable width but shrinks on narrow screens. The page reaches
// under an installed iPhone app's status bar (viewport-fit=cover), so the padding is at least
// the safe area on every side.
const inset = (side: string) => `max(var(--spacing-6), env(safe-area-inset-${side}, 0px))`;
const pageStyle: CSSProperties = {
  minHeight: "100dvh",
  backgroundColor: "var(--color-background-body)",
  paddingTop: inset("top"),
  paddingRight: inset("right"),
  paddingBottom: inset("bottom"),
  paddingLeft: inset("left"),
};
const columnStyle: CSSProperties = { width: "100%", maxWidth: 400 };

/** The shared frame of the signed-out pages: one centred card with the page title. */
export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Center axis="both" padding={6} style={pageStyle}>
      <VStack gap={4} hAlign="center" style={columnStyle}>
        <SystemBanners container="card" />
        <VStack gap={2} hAlign="center">
          <AppLogo size="lg" />
          <Text type="body" weight="bold" size="lg">
            {t("app.name")}
          </Text>
        </VStack>
        <Card padding={8} width="100%">
          <VStack gap={4} hAlign="stretch">
            <VStack gap={1} hAlign="center">
              <Heading level={1}>{title}</Heading>
              {description && (
                <Text type="body" color="secondary" size="sm" justify="center">
                  {description}
                </Text>
              )}
            </VStack>
            {children}
          </VStack>
        </Card>
        <PreferenceSelectors />
      </VStack>
    </Center>
  );
}
