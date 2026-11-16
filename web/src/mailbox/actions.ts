import type { ReaderAction } from "../reader/Reader";
import type { Flags, ListQuery, MessageItem } from "./api";

/** The flags each toolbar and shortcut action sets. */
export const ACTION_FLAGS: Record<Exclude<ReaderAction, "delete">, Flags> = {
  archive: { archived: true },
  unarchive: { archived: false },
  trash: { trashed: true },
  restore: { trashed: false },
  star: { starred: true },
  unstar: { starred: false },
  unread: { read: false },
};

export type BulkAction = Exclude<ReaderAction, "delete"> | "read";

/** Whether a message still belongs in the list after its flags changed. */
export function belongs(item: MessageItem, query: ListQuery): boolean {
  if ("search" in query) return !item.trashed;
  switch (query.folder) {
    case "inbox":
      return !item.trashed && !item.archived;
    case "starred":
      return item.starred && !item.trashed;
    case "archive":
      return item.archived && !item.trashed;
    case "trash":
      return item.trashed;
  }
}
