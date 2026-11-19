import { senderAddress } from "../src/mailbox/api";

// The mailbox routes of the API stand-in, as worker/src/mail/{routes,bulk,flags,folders,spam}.ts
// answer them (docs/M8-mailbox-ux.md): folder tests, the transition policy of decision 6, Report
// spam and Not spam with sender learning, the count route, folder-form PATCH by seq, bulk delete,
// purge with watermark and asOf, and the Spam senders list. The Worker's own suite proves the SQL.

export type Stored = {
  item: Record<string, unknown>;
  raw: string;
  /** The insertion sequence (messages.seq), given on first sight as the trigger does. */
  seq?: number;
  trashedAt?: number;
  spamAt?: number;
};

export type MailCall = { method: string; path: string; body: unknown };

type Item = Record<string, unknown>;
type Flags = Partial<Record<"read" | "starred" | "archived" | "trashed" | "spam", boolean>>;

const FLAG_NAMES = ["read", "starred", "archived", "trashed", "spam"] as const;
const PAGE_MAX = 50;
const BULK_MAX = 100;

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** FOLDERS in worker/src/mail/folders.ts. */
const FOLDERS: Record<string, (i: Item) => boolean> = {
  inbox: (i) => i.direction === "in" && !i.trashed && !i.archived && !i.spam,
  sent: (i) => i.direction === "out" && !i.trashed && !i.spam,
  starred: (i) => Boolean(i.starred) && !i.trashed && !i.spam,
  archive: (i) => Boolean(i.archived) && !i.trashed && !i.spam,
  spam: (i) => Boolean(i.spam) && !i.trashed,
  trash: (i) => Boolean(i.trashed),
};
const DELETABLE = new Set(["trash", "spam"]);

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function parseFlags(body: Record<string, unknown>): Flags | null {
  const flags: Flags = {};
  for (const name of FLAG_NAMES) {
    const v = body[name];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return null;
    flags[name] = v;
  }
  return Object.keys(flags).length > 0 ? flags : null;
}

/** The sender key the consumer stores (`from_key`): the From address, lowercased. */
const fromKey = (i: Item) =>
  i.direction === "in" ? senderAddress(String(i.from)).toLowerCase() : null;

export class MailboxStub {
  /** messages_seq in the counters table. */
  counter = 0;
  /** spam_senders: address to created_at. */
  senders = new Map<string, number>();
  calls: MailCall[] = [];
  /** FOLDER_PATCH_MAX and PURGE_MAX; a test may lower them to see the loops continue. */
  folderPatchMax = 500;
  purgeMax = 100;

  constructor(
    private readonly store: () => Map<string, Stored>,
    private readonly patches: { path: string; body: Record<string, unknown> }[],
  ) {}

  /** Numbers rows the stand-in has not seen yet, and starts the clock of rows added in a folder. */
  private sync(): Stored[] {
    const all = [...this.store().values()];
    for (const m of all) {
      if (m.seq === undefined) m.seq = ++this.counter;
      if (m.item.trashed && m.trashedAt === undefined) m.trashedAt = Date.now() - 1;
      if (m.item.spam && m.spamAt === undefined) m.spamAt = Date.now() - 1;
    }
    return all;
  }

  private view(folder: string, address: number | undefined): Stored[] {
    const test = FOLDERS[folder] ?? (() => false);
    return this.sync().filter(
      (m) => test(m.item) && (address === undefined || m.item.addressId === address),
    );
  }

  /** flagStatement in worker/src/mail/flags.ts, on one row. */
  private apply(m: Stored, request: Flags, now: number) {
    const f = { ...request };
    if (f.trashed === true || (f.archived === true && f.spam !== true)) f.spam = false;
    const old = { ...m.item };
    const enter = f.spam === true && old.direction === "in";
    const next: Item = {};
    if (f.read !== undefined) next.read = f.read;
    if (f.starred !== undefined) next.starred = f.starred;
    next.archived = enter
      ? false
      : f.archived !== undefined
        ? f.archived
        : f.spam === false && old.spam
          ? false
          : old.archived;
    next.trashed = enter ? false : (f.trashed ?? old.trashed);
    if (enter || f.trashed === false) m.trashedAt = undefined;
    else if (f.trashed === true && !old.trashed) m.trashedAt = now;
    next.spam = enter ? true : f.spam === false ? false : old.spam;
    if (enter) m.spamAt = old.spam && !old.trashed ? (m.spamAt ?? now) : now;
    else if (f.spam === false) m.spamAt = undefined;
    Object.assign(m.item, next);
  }

  /** updateMessageFlags with `learn`: the sender keys change with the flags, read before them. */
  private update(ids: string[], flags: Flags, learn: boolean): number {
    const now = Date.now();
    const rows = [...new Set(ids)].flatMap((id) => {
      const m = this.store().get(id);
      return m ? [m] : [];
    });
    if (learn && flags.spam === true && flags.trashed !== true) {
      for (const m of rows) {
        const key = fromKey(m.item);
        if (!m.item.spam && key && !this.senders.has(key)) this.senders.set(key, now);
      }
    }
    if (learn && flags.spam === false) {
      for (const m of rows) {
        const key = fromKey(m.item);
        if (m.item.spam && key) this.senders.delete(key);
      }
    }
    for (const m of rows) this.apply(m, flags, now);
    return rows.length;
  }

  private remove(rows: Stored[]): string[] {
    for (const m of rows) this.store().delete(m.item.id as string);
    return rows.map((m) => m.item.id as string);
  }

  private list(url: URL): Response {
    const folder = url.searchParams.get("folder") ?? "inbox";
    const address = url.searchParams.get("address");
    const cursor = url.searchParams.get("cursor");
    const rows = this.view(folder, address === null ? undefined : Number(address))
      .map((m) => m.item)
      .sort(
        (a, b) =>
          (b.receivedAt as number) - (a.receivedAt as number) ||
          String(b.id).localeCompare(String(a.id)),
      );
    let start = 0;
    if (cursor) {
      const [at, id] = [Number(cursor.split(":")[0]), cursor.slice(cursor.indexOf(":") + 1)];
      start = rows.findIndex(
        (r) => (r.receivedAt as number) < at || (r.receivedAt === at && String(r.id) < id),
      );
      if (start === -1) start = rows.length;
    }
    const page = rows.slice(start, start + PAGE_MAX);
    const last = page.at(-1);
    const more = rows.length > start + PAGE_MAX;
    return json({
      messages: page,
      nextCursor: more && last ? `${last.receivedAt}:${last.id}` : null,
    });
  }

  private counts(): Response {
    const unread = this.sync().filter((m) => !m.item.read);
    const folders = Object.fromEntries(
      ["inbox", "starred", "archive", "spam", "trash"].map((f) => [
        f,
        unread.filter((m) => FOLDERS[f]?.(m.item)).length,
      ]),
    );
    const addresses: Record<string, number> = {};
    for (const m of unread) {
      const i = m.item;
      if (!i.trashed && !i.archived && !i.spam) {
        addresses[String(i.addressId)] = (addresses[String(i.addressId)] ?? 0) + 1;
      }
    }
    return json({ folders, addresses });
  }

  private patchFolder(body: Record<string, unknown>, flags: Flags): Response {
    const { folder, address, watermark, after } = body;
    if (
      body.ids !== undefined ||
      typeof folder !== "string" ||
      !FOLDERS[folder] ||
      (address !== undefined && !Number.isSafeInteger(address)) ||
      !isCount(watermark) ||
      (after !== undefined && !isCount(after))
    ) {
      return json({ error: "bad_request" }, 400);
    }
    const rows = this.view(folder, address as number | undefined)
      .filter(
        (m) => (m.seq as number) <= watermark && (after === undefined || (m.seq as number) < after),
      )
      .sort((a, b) => (b.seq as number) - (a.seq as number))
      .slice(0, this.folderPatchMax);
    const now = Date.now();
    for (const m of rows) this.apply(m, flags, now);
    const lowest = Math.min(...rows.map((m) => m.seq as number));
    return json({ updated: rows.length, next: rows.length < this.folderPatchMax ? null : lowest });
  }

  private purge(body: Record<string, unknown>): Response {
    const { folder, address, watermark, asOf } = body;
    if (
      typeof folder !== "string" ||
      !DELETABLE.has(folder) ||
      (address !== undefined && !Number.isSafeInteger(address)) ||
      !isCount(watermark) ||
      !isCount(asOf)
    ) {
      return json({ error: "bad_request" }, 400);
    }
    const clock = (m: Stored) => (folder === "trash" ? m.trashedAt : m.spamAt) ?? 0;
    const due = this.view(folder, address as number | undefined)
      .filter((m) => (m.seq as number) <= watermark && clock(m) < asOf)
      .sort((a, b) => clock(a) - clock(b));
    const deleted = this.remove(due.slice(0, this.purgeMax));
    return json({ deleted, hasMore: due.length > deleted.length });
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/counts") return this.counts();
    if (path === "/api/spam-senders") {
      const body = method === "DELETE" ? ((await req.json()) as Record<string, unknown>) : null;
      this.calls.push({ method, path, body });
      if (method === "GET") {
        const senders = [...this.senders]
          .map(([address, createdAt]) => ({ address, createdAt }))
          .sort((a, b) => b.createdAt - a.createdAt || a.address.localeCompare(b.address));
        return json({ senders });
      }
      const address = body?.address;
      if (typeof address !== "string" || address.length === 0) {
        return json({ error: "bad_request" }, 400);
      }
      return json({ removed: this.senders.delete(address) });
    }
    if (!path.startsWith("/api/messages")) return null;
    if (path === "/api/messages" && method === "GET") return this.list(url);
    if (path === "/api/messages/count" && method === "GET") {
      const folder = url.searchParams.get("folder") ?? "inbox";
      const address = url.searchParams.get("address");
      this.calls.push({ method, path: `${path}${url.search}`, body: null });
      if (!FOLDERS[folder]) return json({ error: "bad_request" }, 400);
      const asOf = Date.now();
      const total = this.view(folder, address === null ? undefined : Number(address)).length;
      return json({ total, watermark: this.counter, asOf });
    }
    if (method === "GET") return null;
    const one = /^\/api\/messages\/([^/]+)$/.exec(path);
    if (method === "DELETE" && one) return this.deleteOne(decodeURIComponent(one[1] ?? ""));
    const body = (await req.json()) as Record<string, unknown>;
    this.calls.push({ method, path, body });
    if (path === "/api/messages/purge" && method === "POST") return this.purge(body);
    if (path === "/api/messages" && method === "DELETE") {
      const ids = body.ids;
      if (typeof body.folder !== "string" || !DELETABLE.has(body.folder) || !Array.isArray(ids)) {
        return json({ error: "bad_request" }, 400);
      }
      if (ids.length === 0) return json({ error: "bad_request" }, 400);
      if (ids.length > BULK_MAX) return json({ error: "too_many_ids" }, 400);
      const test = FOLDERS[body.folder] as (i: Item) => boolean;
      const rows = this.sync().filter((m) => ids.includes(m.item.id) && test(m.item));
      return json({ deleted: this.remove(rows) });
    }
    if (method !== "PATCH") return null;
    this.patches.push({ path, body });
    const flags = parseFlags(body);
    if (!flags) return json({ error: "bad_request" }, 400);
    if (path === "/api/messages") {
      if (body.folder !== undefined) return this.patchFolder(body, flags);
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return json({ error: "bad_request" }, 400);
      if (ids.length > BULK_MAX) return json({ error: "too_many_ids" }, 400);
      return json({ updated: this.update(ids as string[], flags, true) });
    }
    const id = decodeURIComponent(path.slice("/api/messages/".length));
    return this.update([id], flags, true) > 0
      ? json({ ok: true })
      : json({ error: "not_found" }, 404);
  }

  /** DELETE /api/messages/:id: one message from Trash or Spam. */
  private deleteOne(id: string): Response {
    const m = this.sync().find((s) => s.item.id === id);
    if (!m) return json({ error: "not_found" }, 404);
    this.calls.push({ method: "DELETE", path: `/api/messages/${id}`, body: null });
    if (!FOLDERS.trash?.(m.item) && !FOLDERS.spam?.(m.item)) {
      return json({ error: "not_in_trash" }, 409);
    }
    this.remove([m]);
    return json({ ok: true });
  }
}
