// The search over messages_fts (owner ruling 2026-11-16). GET /api/search builds its query
// here. The trigram tokenizer only matches terms of at least 3 characters, so a shorter term
// (a 2-character Chinese word such as 邮件) is matched with LIKE over the same columns instead.
// User input never becomes FTS5 syntax or a LIKE wildcard: each long term is one quoted phrase,
// each short term an escaped LIKE pattern, and both are bound parameters.

/** Characters a trigram MATCH term needs. */
const TRIGRAM = 3;
const MAX_TERMS = 8;

/** An FTS5 string: double quotes doubled, so the term is one literal phrase. */
function phrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** A LIKE pattern that matches the term literally anywhere, with \ as the escape character. */
function contains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export type SearchFilter = { where: string; params: string[] };

/**
 * The WHERE clause over messages_fts that matches every whitespace-separated term of `input`.
 * Null for blank input. GET /api/search pages its matches newest first.
 */
export function searchFilter(input: string): SearchFilter | null {
  const terms = input.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  const long = terms.filter((t) => [...t].length >= TRIGRAM);
  const short = terms.filter((t) => [...t].length < TRIGRAM);
  const where: string[] = [];
  const params: string[] = [];
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
  return { where: where.join(" AND "), params };
}
