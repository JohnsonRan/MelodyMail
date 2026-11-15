// The search over messages_fts (owner ruling 2026-11-16). The M4 search route builds its query
// here. The trigram tokenizer only matches terms of at least 3 characters, so a shorter term
// (a 2-character Chinese word such as 邮件) is matched with LIKE over the same columns instead.
// User input never becomes FTS5 syntax or a LIKE wildcard: each long term is one quoted phrase,
// each short term an escaped LIKE pattern, and both are bound parameters.

/** Characters a trigram MATCH term needs. */
const TRIGRAM = 3;
const MAX_TERMS = 8;
export const SEARCH_LIMIT = 50;

export type SearchQuery = { sql: string; params: (string | number)[] };

/** An FTS5 string: double quotes doubled, so the term is one literal phrase. */
function phrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** A LIKE pattern that matches the term literally anywhere, with \ as the escape character. */
function contains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * The query for the message ids matching every whitespace-separated term of `input`, best match
 * first when a long term is present, else newest first. Null for blank input.
 */
export function buildSearch(input: string, limit = SEARCH_LIMIT): SearchQuery | null {
  const terms = input.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  const long = terms.filter((t) => [...t].length >= TRIGRAM);
  const short = terms.filter((t) => [...t].length < TRIGRAM);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (long.length > 0) {
    where.push("messages_fts MATCH ?");
    params.push(long.map(phrase).join(" "));
  }
  for (const term of short) {
    const pattern = contains(term);
    where.push(
      "(subject LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  const order = long.length > 0 ? "rank" : "rowid DESC";
  params.push(limit);
  return {
    sql: `SELECT message_id FROM messages_fts WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`,
    params,
  };
}
