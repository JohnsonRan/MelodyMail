import { Grid } from "@astryxdesign/core/Grid";
import { VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/** One Settings > Security section: heading and description beside its content. */
export function SecuritySection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Grid columns={{ minWidth: 320 }} gap={10}>
      <VStack gap={1}>
        <Heading level={2}>{title}</Heading>
        <Text type="supporting" color="secondary">
          {description}
        </Text>
      </VStack>
      <VStack gap={4} hAlign="stretch">
        {children}
      </VStack>
    </Grid>
  );
}

/** The loading state of a section's list: two rows at their final height. */
export function RowsSkeleton() {
  return (
    <VStack gap={2} hAlign="stretch">
      {[0, 1].map((i) => (
        <Skeleton key={i} height="var(--size-control-lg)" index={i} />
      ))}
    </VStack>
  );
}

/**
 * A list row's secondary lines, one fact per line and never truncated: a plain string
 * description would be cut to one line with an ellipsis, hiding dates (web/AGENTS.md).
 */
export function Meta({ lines }: { lines: string[] }) {
  return (
    <VStack gap={0}>
      {lines.map((line) => (
        <Text key={line} type="supporting" color="secondary">
          {line}
        </Text>
      ))}
    </VStack>
  );
}
