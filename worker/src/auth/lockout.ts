// Strict lockout for POST /api/auth/recover, counted in D1 because the Rate Limiting binding is
// approximate. Two counters (owner ruling 2026-11-15): one per client IP, so one attacker cannot
// lock the owner out, and one global ceiling against attacks spread over many IPs.
// Way out: the window passes, or the owner runs
// `wrangler d1 execute melodymail --remote --command "DELETE FROM login_attempts"`.
export const LOCKOUT_WINDOW_MS = 15 * 60_000;
export const PER_IP_FAILURES = 5;
export const GLOBAL_FAILURES = 20;

const GLOBAL_SCOPE = "recover";
const ipScope = (ip: string) => `recover:ip:${ip}`;

/**
 * Reserves one attempt in both counters before the credentials are checked. Returns 0 when
 * reserved, or the seconds until the counter that blocks frees up.
 *
 * One batch, run as one transaction: the deletes keep only the window's rows; the per-IP insert
 * happens only while both counters are under their limits; the global insert happens only when
 * the per-IP insert did (changes() reads the statement before it). A locked attempt is counted
 * in neither, so it cannot extend a lock.
 */
export async function reserveAttempt(db: D1Database, ip: string, now: number) {
  const since = now - LOCKOUT_WINDOW_MS;
  const scope = ipScope(ip);
  const [, , reserved] = await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE scope = ? AND created_at <= ?").bind(scope, since),
    db
      .prepare("DELETE FROM login_attempts WHERE scope = ? AND created_at <= ?")
      .bind(GLOBAL_SCOPE, since),
    db
      .prepare(
        "INSERT INTO login_attempts (scope, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM login_attempts WHERE scope = ?) < ? AND (SELECT COUNT(*) FROM login_attempts WHERE scope = ?) < ?",
      )
      .bind(scope, now, scope, PER_IP_FAILURES, GLOBAL_SCOPE, GLOBAL_FAILURES),
    db
      .prepare("INSERT INTO login_attempts (scope, created_at) SELECT ?, ? WHERE changes() = 1")
      .bind(GLOBAL_SCOPE, now),
  ]);
  if (reserved?.meta.changes === 1) return 0;
  const { results } = await db
    .prepare(
      "SELECT scope, COUNT(*) AS n, MIN(created_at) AS oldest FROM login_attempts WHERE scope IN (?, ?) GROUP BY scope",
    )
    .bind(scope, GLOBAL_SCOPE)
    .all<{ scope: string; n: number; oldest: number }>();
  let until = now;
  for (const row of results) {
    const limit = row.scope === GLOBAL_SCOPE ? GLOBAL_FAILURES : PER_IP_FAILURES;
    if (row.n >= limit) until = Math.max(until, row.oldest + LOCKOUT_WINDOW_MS);
  }
  return Math.max(1, Math.ceil((until - now) / 1000));
}

/** After a successful recovery: the owner proved both factors, so both counters start over. */
export function clearFailures(db: D1Database, ip: string) {
  return db
    .prepare("DELETE FROM login_attempts WHERE scope IN (?, ?)")
    .bind(ipScope(ip), GLOBAL_SCOPE);
}
