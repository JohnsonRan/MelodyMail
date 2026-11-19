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
};

export type BulkAction = Exclude<ReaderAction, "delete"> | "read";

/** The actions a swipe can run. */
export type SwipeAction = Extract<BulkAction, "archive" | "unarchive" | "trash" | "restore">;
export type SwipeSide = "left" | "right";

// Swipe right moves mail along (Archive, Move to Inbox, Restore); swipe left sends it to Trash.
// Trash has no left swipe, so a gesture never deletes forever. A folder without an entry uses
// DEFAULT_SWIPES; Spam is one more entry: { right: "notSpam" }.
const DEFAULT_SWIPES: Partial<Record<SwipeSide, SwipeAction>> = { right: "archive", left: "trash" };
const FOLDER_SWIPES: Partial<Record<Folder, Partial<Record<SwipeSide, SwipeAction>>>> = {
  archive: { right: "unarchive", left: "trash" },
  trash: { right: "restore" },
};

/** What a swipe on a row of this view does; a side that is missing does nothing. */
export function swipeActions(query: ListQuery): Partial<Record<SwipeSide, SwipeAction>> {
  if ("search" in query) return {};
  return FOLDER_SWIPES[query.folder] ?? DEFAULT_SWIPES;
}

/** Whether a message still belongs in the list after its flags changed. */
export function belongs(item: MessageItem, query: ListQuery): boolean {
  if ("search" in query) return !item.trashed;
  switch (query.folder) {
    case "inbox":
      return item.direction === "in" && !item.trashed && !item.archived;
    case "sent":
      return item.direction === "out" && !item.trashed;
    case "starred":
      return item.starred && !item.trashed;
    case "archive":
      return item.archived && !item.trashed;
    case "trash":
      return item.trashed;
  }
}
