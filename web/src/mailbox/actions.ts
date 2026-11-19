import type { ReaderAction } from "../reader/ReaderToolbar";
import type { Flags, Folder, ListQuery, MessageItem } from "./api";

/** The flags each toolbar and shortcut action sets. */
export const ACTION_FLAGS: Record<Exclude<ReaderAction, "delete">, Flags> = {
  archive: { archived: true },
  unarchive: { archived: false },
  trash: { trashed: true },
  restore: { trashed: false },
  star: { starred: true },
  unstar: { starred: false },
  unread: { read: false },
  reportSpam: { spam: true },
  notSpam: { spam: false },
};

export type BulkAction = Exclude<ReaderAction, "delete"> | "read";

/** The actions a swipe can run. */
export type SwipeAction = Extract<
  BulkAction,
  "archive" | "unarchive" | "trash" | "restore" | "notSpam"
>;
export type SwipeSide = "left" | "right";

// Swipe right moves mail along (Archive, Move to Inbox, Restore, Not spam); swipe left sends it
// to Trash. Trash and Spam have no left swipe, so a gesture never deletes forever. A folder
// without an entry uses DEFAULT_SWIPES.
const DEFAULT_SWIPES: Partial<Record<SwipeSide, SwipeAction>> = { right: "archive", left: "trash" };
const FOLDER_SWIPES: Partial<Record<Folder, Partial<Record<SwipeSide, SwipeAction>>>> = {
  archive: { right: "unarchive", left: "trash" },
  trash: { right: "restore" },
  spam: { right: "notSpam" },
};

/** What a swipe on a row of this view does; a side that is missing does nothing. */
export function swipeActions(query: ListQuery): Partial<Record<SwipeSide, SwipeAction>> {
  if ("search" in query) return {};
  return FOLDER_SWIPES[query.folder] ?? DEFAULT_SWIPES;
}

/**
 * The message after a flag change. Mail you sent never enters Spam (docs/M8-mailbox-ux.md,
 * decision 6): the Worker ignores Report spam on it, so it stays in Starred.
 */
export function withFlags(item: MessageItem, flags: Flags): MessageItem {
  if (flags.spam !== true || item.direction === "in") return { ...item, ...flags };
  const { spam: _, ...rest } = flags;
  return { ...item, ...rest };
}

/** Whether a message still belongs in the list after its flags changed. */
export function belongs(item: MessageItem, query: ListQuery): boolean {
  if ("search" in query) return !item.trashed && !item.spam;
  switch (query.folder) {
    case "inbox":
      return item.direction === "in" && !item.trashed && !item.archived && !item.spam;
    case "sent":
      return item.direction === "out" && !item.trashed && !item.spam;
    case "starred":
      return item.starred && !item.trashed && !item.spam;
    case "archive":
      return item.archived && !item.trashed && !item.spam;
    case "spam":
      return item.spam && !item.trashed;
    case "trash":
      return item.trashed;
  }
}
