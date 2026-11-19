import { parseFlag } from "../domains/validate";
import type { Env } from "../env";

// Flag changes and the one transition policy of docs/M8-mailbox-ux.md, decision 6. The session
// routes, the REST API v1, the Telegram card buttons and (through the same rules) the inbound
// INSERT all follow it:
// - entering Spam clears archived and trashed and starts spam_at;
// - entering Trash or Archive leaves Spam; Trash beats Spam and Spam beats Archive;
// - Not spam clears spam and archived, so the message lands in the Inbox;
// - a clock (trashed_at, spam_at) is set only on entry and kept while the message stays;
// - outbound rows never enter Spam.

export type Flags = {
  read?: boolean;
  starred?: boolean;
  archived?: boolean;
  trashed?: boolean;
  spam?: boolean;
};

export const V1_FLAGS = ["read", "starred", "archived", "trashed"] as const;
export const SESSION_FLAGS = [...V1_FLAGS, "spam"] as const;

/** The named flags of a body; null when one has the wrong type or none is given. */
export function parseFlags(
  body: Record<string, unknown>,
  names: readonly (keyof Flags)[],
): Flags | null {
  const flags: Flags = {};
  for (const key of names) {
    const parsed = parseFlag(body[key]);
    if (!parsed.ok) return null;
    if (parsed.value !== undefined) flags[key] = parsed.value;
  }
  return Object.keys(flags).length > 0 ? flags : null;
}

/** A WHERE clause naming the rows to change, with its parameters. */
export type Target = { sql: string; params: (string | number)[] };

export const idsTarget = (ids: string[]): Target => ({
  sql: "id IN (SELECT value FROM json_each(?))",
  params: [JSON.stringify(ids)],
});

const bit = (value: boolean | undefined) => (value === undefined ? null : Number(value));

/** The request after the precedence rules: Trash beats Spam, and Trash or Archive leave Spam. */
function resolve(flags: Flags): Flags {
  const out = { ...flags };
  if (out.trashed === true || (out.archived === true && out.spam !== true)) out.spam = false;
  return out;
}

/**
 * One UPDATE of the target rows; a flag left out keeps its value. SET reads the old row, so
 * `trashed = 1` and `spam = 1` below mean "already there". ?5 = 1 on an inbound row is entering
 * Spam; an outbound row ignores it. Unnumbered parameters in the target follow ?6.
 */
export function flagStatement(
  db: D1Database,
  target: Target,
  flags: Flags,
  now: number,
  returning = "",
) {
  const f = resolve(flags);
  const enter = "(?5 = 1 AND direction = 'in')";
  return db
    .prepare(
      `UPDATE messages SET read = COALESCE(?1, read), starred = COALESCE(?2, starred),
         archived = CASE WHEN ${enter} THEN 0 WHEN ?3 IS NOT NULL THEN ?3
           WHEN ?5 = 0 AND spam = 1 THEN 0 ELSE archived END,
         trashed = CASE WHEN ${enter} THEN 0 ELSE COALESCE(?4, trashed) END,
         trashed_at = CASE WHEN ${enter} THEN NULL WHEN ?4 IS NULL THEN trashed_at
           WHEN ?4 = 0 THEN NULL WHEN trashed = 1 THEN trashed_at ELSE ?6 END,
         spam = CASE WHEN ${enter} THEN 1 WHEN ?5 = 0 THEN 0 ELSE spam END,
         spam_at = CASE WHEN ${enter} THEN
             CASE WHEN spam = 1 AND trashed = 0 THEN COALESCE(spam_at, ?6) ELSE ?6 END
           WHEN ?5 = 0 THEN NULL ELSE spam_at END
       WHERE ${target.sql}${returning && ` RETURNING ${returning}`}`,
    )
    .bind(
      bit(f.read),
      bit(f.starred),
      bit(f.archived),
      bit(f.trashed),
      bit(f.spam),
      now,
      ...target.params,
    );
}

/**
 * Report spam and Not spam on listed ids: the sender keys change in the same batch as the flags,
 * and are read before the UPDATE, so only rows that actually enter or leave Spam count. Report
 * spam adds the key of an inbound row entering Spam; Not spam removes the key of a row leaving it.
 */
function senderStatement(db: D1Database, ids: string[], flags: Flags, now: number) {
  const list = JSON.stringify(ids);
  if (flags.spam === true && flags.trashed !== true) {
    return db
      .prepare(
        `INSERT OR IGNORE INTO spam_senders (address, created_at)
         SELECT from_key, ? FROM messages WHERE id IN (SELECT value FROM json_each(?))
           AND direction = 'in' AND spam = 0 AND from_key IS NOT NULL`,
      )
      .bind(now, list);
  }
  if (flags.spam === false) {
    return db
      .prepare(
        `DELETE FROM spam_senders WHERE address IN (
           SELECT from_key FROM messages WHERE id IN (SELECT value FROM json_each(?))
             AND spam = 1 AND from_key IS NOT NULL)`,
      )
      .bind(list);
  }
  return null;
}

export type UpdateOptions = {
  /** Report spam / Not spam: learn or forget the senders of the listed rows. */
  learn?: boolean;
  /** An extra condition on every row, such as the REST API's `spam = 0`. */
  only?: string;
};

/**
 * Changes the flags of the listed ids; the panel, the REST API and the Telegram card buttons all
 * end here. Returns the UPDATE's result.
 */
export async function updateMessageFlags(
  env: Env,
  ids: string[],
  flags: Flags,
  options: UpdateOptions = {},
): Promise<D1Result> {
  const db = env.DB;
  const now = Date.now();
  const target = idsTarget(ids);
  if (options.only) target.sql += ` AND ${options.only}`;
  const update = flagStatement(db, target, flags, now);
  const senders = options.learn ? senderStatement(db, ids, flags, now) : null;
  if (!senders) return update.run();
  const [, result] = await db.batch([senders, update]);
  return result as D1Result;
}
