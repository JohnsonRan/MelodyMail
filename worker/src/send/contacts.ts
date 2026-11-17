import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { fail } from "../http";
import { contains } from "../mail/search";

// GET /api/contacts?q=&limit=: recipient suggestions for compose. A contact is an address the
// owner sent to (To, Cc, Bcc) or received mail from (From), newest use first. Mail in Trash and
// permanently deleted mail do not count, so trashing a sender's mail drops the suggestion. The
// owner's own addresses are left out.

const QUERY_MAX = 100;
const LIMIT_DEFAULT = 8;
const LIMIT_MAX = 20;
/** The newest messages read per direction: bounds the rows D1 reads per request. */
export const SCAN_ROWS = 1000;
/** Matching messages parsed per direction: bounds the Worker's CPU time per request. */
export const MATCH_ROWS = 50;

export type Contact = { address: string; name: string };
/** One message: when it was used, and its stored address headers. */
export type ContactRow = { at: number; headers: (string | null)[] };

// A stored header is a list of "Name <a@x>" and bare addresses, joined by ", " (the parse in
// worker/src/mail/parse.ts, and the sent copy's bare addresses). The header comes from a sender,
// so the scan stays linear: a bare address starts only where a run of address characters starts
// (the lookbehind), so a long run without "@" is tried once, not once per character, and every
// part is bounded by the 254-character address limit.
const ADDRESS =
  /<([^<>\s]{1,254}@[^<>\s]{1,254})>|(?<![^\s<>,;:()"])([^\s<>,;:()"]{1,254}@[^\s<>,;:()"]{1,254})/g;

/** The addresses of one stored header with their display names ("" when none). */
export function headerAddresses(header: string): Contact[] {
  const out: Contact[] = [];
  let end = 0;
  for (const m of header.matchAll(ADDRESS)) {
    const name = m[1]
      ? header
          .slice(end, m.index)
          .replace(/^[\s,;]+/, "")
          .trim()
          .replace(/^"(.*)"$/, "$1")
      : "";
    out.push({ address: m[1] ?? m[2] ?? "", name });
    end = m.index + m[0].length;
  }
  return out;
}

/**
 * Up to `limit` contacts whose address or name contains `query` (case-insensitive), from `rows`
 * newest first. A contact keeps the first name found for it, newest first.
 */
export function rankContacts(
  rows: ContactRow[],
  own: Set<string>,
  query: string,
  limit: number,
): Contact[] {
  const needle = query.toLowerCase();
  const found = new Map<string, Contact>();
  for (const row of [...rows].sort((a, b) => b.at - a.at)) {
    for (const header of row.headers) {
      if (!header) continue;
      for (const contact of headerAddresses(header)) {
        const key = contact.address.toLowerCase();
        if (own.has(key)) continue;
        if (!key.includes(needle) && !contact.name.toLowerCase().includes(needle)) continue;
        const known = found.get(key);
        if (!known) found.set(key, contact);
        else if (!known.name) known.name = contact.name;
      }
    }
  }
  return [...found.values()].slice(0, limit);
}

export function registerContactRoutes(contacts: Hono<AppEnv>): void {
  contacts.get("/", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? LIMIT_DEFAULT : Number(rawLimit);
    if (!q || q.length > QUERY_MAX || !Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
      return fail(c, 400, "bad_request");
    }
    const db = c.env.DB;
    const pattern = contains(q);
    // The inner query walks messages_direction_received newest first and stops at SCAN_ROWS.
    const [received, sent, addresses] = await db.batch([
      db
        .prepare(
          `SELECT received_at AS at, from_hdr AS h FROM (
             SELECT received_at, from_hdr FROM messages WHERE direction = 'in' AND trashed = 0
             ORDER BY received_at DESC LIMIT ?2)
           WHERE from_hdr LIKE ?1 ESCAPE '\\' ORDER BY received_at DESC LIMIT ?3`,
        )
        .bind(pattern, SCAN_ROWS, MATCH_ROWS),
      db
        .prepare(
          `SELECT received_at AS at, to_hdr AS h, cc_hdr AS h2, bcc_hdr AS h3 FROM (
             SELECT received_at, to_hdr, cc_hdr, bcc_hdr FROM messages
             WHERE direction = 'out' AND trashed = 0 ORDER BY received_at DESC LIMIT ?2)
           WHERE to_hdr LIKE ?1 ESCAPE '\\' OR cc_hdr LIKE ?1 ESCAPE '\\'
             OR bcc_hdr LIKE ?1 ESCAPE '\\'
           ORDER BY received_at DESC LIMIT ?3`,
        )
        .bind(pattern, SCAN_ROWS, MATCH_ROWS),
      db.prepare("SELECT lower(local_part || '@' || domain) AS address FROM addresses"),
    ]);
    type Row = { at: number; h: string | null; h2?: string | null; h3?: string | null };
    const rows = [...(received?.results ?? []), ...(sent?.results ?? [])].map((r) => {
      const row = r as Row;
      return { at: row.at, headers: [row.h, row.h2 ?? null, row.h3 ?? null] };
    });
    const own = new Set(
      ((addresses?.results ?? []) as { address: string }[]).map((r) => r.address),
    );
    return c.json({ contacts: rankContacts(rows, own, q, limit) });
  });
}
