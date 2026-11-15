import { HStack, Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { Heading } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/**
 * The signed-in page frame: the page's one title, its actions at the end of the title row, and
 * the content below at the shared padding and section gap (web/AGENTS.md, Page titles). A
 * mailbox page adds a toolbar row under the title and a reading pane in the end slot.
 */
export function PageFrame({
  title,
  actions,
  toolbar,
  end,
  children,
}: {
  title: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  end?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <VStack gap={2} hAlign="stretch">
            <HStack hAlign="between" vAlign="center" gap={4} wrap="wrap">
              <Heading level={1}>{title}</Heading>
              {actions && <HStack gap={2}>{actions}</HStack>}
            </HStack>
            {toolbar}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={4}>
          <VStack gap={4} hAlign="stretch">
            {children}
          </VStack>
        </LayoutContent>
      }
      end={end}
    />
  );
}
