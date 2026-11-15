import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PreferenceSelectors } from "../preferences";

// From the Astryx login-card template: the page paints its own body background, and the column
// is capped at the template's readable width but shrinks on narrow screens.
const pageStyle: CSSProperties = {
  minHeight: "100dvh",
  backgroundColor: "var(--color-background-body)",
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
        <VStack gap={2} hAlign="center">
          <Icon icon={EnvelopeIcon} size="lg" />
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
