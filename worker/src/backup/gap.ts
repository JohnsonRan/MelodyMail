import { parseRecipient } from "../mail/inbound";

// The gap tool's core (docs/M7-ops.md, "Mail after the restore point"; owner ruling 2,
// 2026-11-17). After a restore to time T, raw objects received after T exist in R2 without a
// row. findGap lists them and reads the metadata email() wrote; gapSql turns them into `stored`
// rows, which the cron re-enqueues and the consumer parses. Sent copies without a row are
// reported, not rebuilt (GapReport.sentNotRebuilt). It only reads; the owner applies the
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
  /** Objects listed under raw/ and sent/ in the months searched. */
  listed: number;
  /** Of those, uploaded after `since` minus OVERLAP_MS. */
  after: number;
  /** Of those, with a row already. */
  present: number;
  rows: GapRow[];
  skipped: { key: string; reason: "no_metadata" | "bad_metadata" | "bad_key" }[];
  /**
   * Mail sent after the restore point, without a row. Not rebuilt: the sent/ copy is written
   * before the Resend call and holds no outcome, so a row could not say whether it went out.
   */
  sentNotRebuilt: { key: string; uploaded: number }[];
};

const KEY = /^raw\/\d{4}\/\d{2}\/([0-9a-f-]{36})\.eml$/;
const LOOKUP_MAX = 100;
/**
 * Listed from this long before the restore point: a Time Travel point can fall between an R2 put
 * and its D1 commit. The present-row check and INSERT OR IGNORE make the overlap harmless.
 */
export const OVERLAP_MS = 10 * 60 * 1000;

/** {root}/YYYY/MM/ from the month before `since` (keys carry the receive month) to `now`'s. */
export function monthPrefixes(since: number, now: number, root = "raw"): string[] {
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
    out.push(`${root}/${year}/${String(month + 1).padStart(2, "0")}/`);
    month++;
  }
}

/** A metadata value as email() wrote it; null when it is absent, undecodable or holds a NUL. */
function decoded(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const text = decodeURIComponent(value);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/**
 * The raw objects uploaded after `since` that have no messages row, as rows to insert, and the
 * sent copies without a row, reported only.
 */
export async function findGap(
  env: { MAIL: R2Bucket; DB: D1Database },
  since: number,
  now = Date.now(),
): Promise<GapReport> {
  const report: GapReport = {
    since,
    listed: 0,
    after: 0,
    present: 0,
    rows: [],
    skipped: [],
    sentNotRebuilt: [],
  };
  const candidates: R2Object[] = [];
  const prefixes = [...monthPrefixes(since, now), ...monthPrefixes(since, now, "sent")];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await env.MAIL.list({ prefix, cursor, include: ["customMetadata"] });
      report.listed += page.objects.length;
      for (const object of page.objects) {
        if (object.uploaded.getTime() > since - OVERLAP_MS) candidates.push(object);
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
      if (present.has(object.key)) continue;
      if (object.key.startsWith("sent/")) {
        report.sentNotRebuilt.push({ key: object.key, uploaded: object.uploaded.getTime() });
      } else {
        addRow(report, object);
      }
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
  if (meta.addressId === undefined && meta.envelopeTo === undefined) {
    // Stored before the metadata existed (M7).
    report.skipped.push({ key: object.key, reason: "no_metadata" });
    return;
  }
  const addressId = Number(meta.addressId);
  const receivedAt = Number(meta.receivedAt);
  // An empty sender is valid: a bounce or an auto-reply has the null reverse-path.
  const envelopeFrom = decoded(meta.envelopeFrom);
  const envelopeTo = decoded(meta.envelopeTo);
  if (
    !/^\d+$/.test(meta.addressId ?? "") ||
    !/^\d+$/.test(meta.receivedAt ?? "") ||
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
