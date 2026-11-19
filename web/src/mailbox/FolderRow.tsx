import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

const NO_SHRINK = { flexShrink: 0 };

/**
 * The row that says what is special about the folder, the 30-day note of Trash and Spam, above a
 * phone list and at the end of the desktop bulk bar. `children` is the slot at the end for the
 * folder's own action (Empty); it keeps its width and the note wraps instead.
 */
export function FolderRow({ note, children }: { note: string; children?: ReactNode }) {
  return (
    <HStack gap={3} vAlign="center" hAlign="between">
      <StackItem size="fill">
        <Text type="supporting">{note}</Text>
      </StackItem>
      {children && <StackItem style={NO_SHRINK}>{children}</StackItem>}
    </HStack>
  );
}
