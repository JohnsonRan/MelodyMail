import { api } from "../api";

// Shapes and calls of the mailbox API (docs/M4-mailbox.md, "API").

export type Folder = "inbox" | "starred" | "sent" | "archive" | "trash";

/** Delivery statuses of a sent message (docs/M5-sending.md, "Webhook"). */
export type SendStatus =
  | "sending"
  | "sent"
  | "delayed"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed";

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
  envelopeFrom: string;
  envelopeTo: string;
  forwardFailed: number;
};

export type MessagePage = { messages: MessageItem[]; nextCursor: string | null };

export type Counts = {
  folders: Partial<Record<Folder, number>>;
  addresses: Record<string, number>;
};

export type Flags = Partial<Pick<MessageItem, "read" | "starred" | "archived" | "trashed">>;

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

/** The API's limit on one bulk change. */
const BULK_MAX = 100;

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
