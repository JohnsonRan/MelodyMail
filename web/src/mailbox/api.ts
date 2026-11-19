import { api } from "../api";

// Shapes and calls of the mailbox API (docs/M4-mailbox.md, "API"; docs/M8-mailbox-ux.md).

export type Folder = "inbox" | "starred" | "sent" | "archive" | "spam" | "trash";

/** The folders whose mail can be deleted forever. */
export type DeletableFolder = Extract<Folder, "trash" | "spam">;

/** Delivery statuses of a sent message (docs/M5-sending.md, "Webhook"). */
export type SendStatus =
  | "sending"
  | "sent"
  | "delayed"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed"
  | "delivery_failed";

export type MessageItem = {
  id: string;
  addressId: number;
  tag: string | null;
  from: string;
  subject: string | null;
  snippet: string | null;
  receivedAt: number;
  date: string | null;
  size: number;
  read: boolean;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
  spam: boolean;
  hasAttachments: boolean;
  status: "stored" | "parsed" | "parse_failed" | SendStatus;
  threadKey: string | null;
  direction: "in" | "out";
  to: string | null;
  /** A failed send's short code. */
  error: string | null;
};

export type MessageDetail = MessageItem & {
  cc: string | null;
  bcc: string | null;
  /** Outbound only: the key a Retry sends again under. */
  idempotencyKey: string | null;
  /** Outbound only: when the first attempt that Resend may have accepted was made. */
  firstAttemptAt: number | null;
  /** Outbound only: 1 when an attempt's outcome is unknown, so Resend may have sent it. */
  maybeAccepted: number;
  envelopeFrom: string;
  envelopeTo: string;
  forwardFailed: number;
};

export type MessagePage = { messages: MessageItem[]; nextCursor: string | null };

export type Counts = {
  folders: Partial<Record<Folder, number>>;
  addresses: Record<string, number>;
};

export type Flags = Partial<
  Pick<MessageItem, "read" | "starred" | "archived" | "trashed" | "spam">
>;

/** Which messages a list shows: a folder (optionally one address), or a search. */
export type ListQuery = { folder: Folder; address?: number } | { search: string };

export function listMessages(query: ListQuery, cursor?: string | null): Promise<MessagePage> {
  const params = new URLSearchParams();
  if ("search" in query) params.set("q", query.search);
  else {
    params.set("folder", query.folder);
    if (query.address !== undefined) params.set("address", String(query.address));
  }
  if (cursor) params.set("cursor", cursor);
  const path = "search" in query ? "/search" : "/messages";
  return api<MessagePage>("GET", `${path}?${params}`);
}

/** One message's metadata (GET /api/messages/:id). */
export function getMessage(id: string): Promise<{ message: MessageDetail }> {
  return api("GET", `/messages/${encodeURIComponent(id)}`);
}

export function getThread(id: string): Promise<{ messages: MessageDetail[] }> {
  return api("GET", `/messages/${encodeURIComponent(id)}/thread`);
}

/** The API's limit on one bulk change or delete. */
export const BULK_MAX = 100;

export async function setFlags(ids: string[], flags: Flags): Promise<void> {
  if (ids.length === 1 && ids[0] !== undefined) {
    await api("PATCH", `/messages/${encodeURIComponent(ids[0])}`, flags);
    return;
  }
  for (let i = 0; i < ids.length; i += BULK_MAX) {
    await api("PATCH", "/messages", { ids: ids.slice(i, i + BULK_MAX), ...flags });
  }
}

export function deleteForever(id: string): Promise<unknown> {
  return api("DELETE", `/messages/${encodeURIComponent(id)}`);
}

/** A folder view, the unit of "select all", Empty and the count route. */
export type FolderView = { folder: Folder; address?: number };

/**
 * What a whole-folder action may touch: the rows at or below `watermark` (the insertion
 * sequence when the count was read), and for a permanent delete only those whose folder clock is
 * before `asOf`. Every call of one loop sends the same pair.
 */
export type FolderCount = { total: number; watermark: number; asOf: number };

export function countMessages(view: FolderView): Promise<FolderCount> {
  const params = new URLSearchParams({ folder: view.folder });
  if (view.address !== undefined) params.set("address", String(view.address));
  return api<FolderCount>("GET", `/messages/count?${params}`);
}

/** One call of a whole-folder flag change; `next` goes back as `after` until it is null. */
export function setFolderFlags(
  view: FolderView,
  watermark: number,
  after: number | null,
  flags: Flags,
): Promise<{ updated: number; next: number | null }> {
  return api("PATCH", "/messages", {
    ...view,
    watermark,
    ...(after === null ? {} : { after }),
    ...flags,
  });
}

/** Deletes up to BULK_MAX listed messages that are in `folder` now; returns the ones deleted. */
export function deleteMessages(
  folder: DeletableFolder,
  ids: string[],
): Promise<{ deleted: string[] }> {
  return api("DELETE", "/messages", { folder, ids });
}

/** One call of Empty or a whole-folder Delete forever. */
export function purgeFolder(
  view: FolderView & { folder: DeletableFolder },
  count: FolderCount,
): Promise<{ deleted: string[]; hasMore: boolean }> {
  return api("POST", "/messages/purge", {
    ...view,
    watermark: count.watermark,
    asOf: count.asOf,
  });
}

export function getCounts(): Promise<Counts> {
  return api<Counts>("GET", "/counts");
}

/** The display name of a From header, or its address when it has none. */
export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from);
  if (!match) return from.trim();
  return (match[1] ?? "").trim() || (match[2] ?? "").trim();
}

/** The address of a From header ("Name <a@b>" gives "a@b"); the header itself when it has none. */
export function senderAddress(from: string): string {
  const match = /<([^>]*)>\s*$/.exec(from);
  return (match?.[1] ?? from).trim();
}
