import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/**
 * The row above a phone list that says what is special about the folder, Trash's 30-day note.
 * `children` is the slot at the end for the folder's own action (Empty Trash).
 */
export function FolderRow({ note, children }: { note: string; children?: ReactNode }) {
  return (
    <HStack gap={3} vAlign="center" hAlign="between">
      <Text type="supporting">{note}</Text>
      {children}
    </HStack>
  );
}
