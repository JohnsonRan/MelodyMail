import { parseRecipient } from "../mail/inbound";

// The gap tool's core (docs/M7-ops.md, "Mail after the restore point"; owner ruling 2,
// 2026-11-17). After a restore to time T, raw objects received after T exist in R2 without a
// row. findGap lists them and reads the metadata email() wrote; gapSql turns them into `stored`
// rows, which the cron re-enqueues and the consumer parses. It only reads; the owner applies the
// SQL. It runs in worker/scripts/gap-worker.ts under `wrangler dev`, never in the deployed Worker.

export type GapRow = {
  id: string;
  key: string;
  addressId: number;
  envelopeFrom: string;
  envelopeTo: string;
  tag: string | null;
  size: number;
  receivedAt: number;
};

export type GapReport = {
  since: number;
  /** Raw objects listed in the months searched. */
  listed: number;
  /** Of those, uploaded after `since`. */
  after: number;
  /** Of those, with a row already. */
  present: number;
  rows: GapRow[];
  skipped: { key: string; reason: "no_metadata" | "bad_metadata" | "bad_key" }[];
};

const KEY = /^raw\/\d{4}\/\d{2}\/([0-9a-f-]{36})\.eml$/;
const LOOKUP_MAX = 100;

/** raw/YYYY/MM/ from the month before `since` (keys carry the receive month) to `now`'s. */
export function monthPrefixes(since: number, now: number): string[] {
  const start = new Date(since);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() - 1;
  const end = new Date(now);
  const out: string[] = [];
  for (;;) {
    if (month < 0) {
      month += 12;
      year--;
    }
    if (month > 11) {
      month -= 12;
      year++;
    }
    if (
      year > end.getUTCFullYear() ||
      (year === end.getUTCFullYear() && month > end.getUTCMonth())
    ) {
      return out;
    }
    out.push(`raw/${year}/${String(month + 1).padStart(2, "0")}/`);
    month++;
  }
}

function decoded(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The raw objects uploaded after `since` that have no messages row, as rows to insert. */
export async function findGap(
  env: { MAIL: R2Bucket; DB: D1Database },
  since: number,
  now = Date.now(),
): Promise<GapReport> {
  const report: GapReport = { since, listed: 0, after: 0, present: 0, rows: [], skipped: [] };
  const candidates: R2Object[] = [];
  for (const prefix of monthPrefixes(since, now)) {
    let cursor: string | undefined;
    do {
      const page = await env.MAIL.list({ prefix, cursor, include: ["customMetadata"] });
      report.listed += page.objects.length;
      for (const object of page.objects) {
        if (object.uploaded.getTime() > since) candidates.push(object);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  report.after = candidates.length;
  for (let i = 0; i < candidates.length; i += LOOKUP_MAX) {
    const chunk = candidates.slice(i, i + LOOKUP_MAX);
    const { results } = await env.DB.prepare(
      "SELECT r2_key AS key FROM messages WHERE r2_key IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(chunk.map((o) => o.key)))
      .all<{ key: string }>();
    const present = new Set(results.map((r) => r.key));
    report.present += present.size;
    for (const object of chunk) {
      if (!present.has(object.key)) addRow(report, object);
    }
  }
  return report;
}

function addRow(report: GapReport, object: R2Object): void {
  const id = KEY.exec(object.key)?.[1];
  if (!id) {
    report.skipped.push({ key: object.key, reason: "bad_key" });
    return;
  }
  const meta = object.customMetadata ?? {};
  if (!meta.addressId && !meta.envelopeTo) {
    // Stored before the metadata existed (M7).
    report.skipped.push({ key: object.key, reason: "no_metadata" });
    return;
  }
  const addressId = Number(meta.addressId);
  const receivedAt = Number(meta.receivedAt);
  const envelopeFrom = decoded(meta.envelopeFrom);
  const envelopeTo = decoded(meta.envelopeTo);
  if (
    !Number.isSafeInteger(addressId) ||
    !Number.isSafeInteger(receivedAt) ||
    envelopeFrom === null ||
    !envelopeTo
  ) {
    report.skipped.push({ key: object.key, reason: "bad_metadata" });
    return;
  }
  report.rows.push({
    id,
    key: object.key,
    addressId,
    envelopeFrom,
    envelopeTo,
    tag: parseRecipient(envelopeTo)?.tag ?? null,
    size: object.size,
    receivedAt,
  });
}

const text = (value: string | null) =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

/**
 * One INSERT per row, as email() would have stored it before any rule ran: status `stored`, no
 * flags. INSERT OR IGNORE, so applying the file twice adds nothing.
 */
export function gapSql(rows: GapRow[]): string {
  return rows
    .map(
      (r) =>
        `INSERT OR IGNORE INTO messages (id, address_id, direction, status, envelope_from, envelope_to, subaddress_tag, raw_size, r2_key, received_at) VALUES (${text(r.id)}, ${r.addressId}, 'in', 'stored', ${text(r.envelopeFrom)}, ${text(r.envelopeTo)}, ${text(r.tag)}, ${r.size}, ${text(r.key)}, ${r.receivedAt});\n`,
    )
    .join("");
}
