// Strict lockout for POST /api/auth/recover, counted in D1 because the Rate Limiting binding is
// approximate. Way out: the window passes, or the owner runs
// `wrangler d1 execute melodymail --remote --command "DELETE FROM login_attempts"`.
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;

/**
 * Reserves one attempt before the credentials are checked: at most 5 attempts per scope in any
 * 15-minute window. Returns 0 when a slot was reserved, or the seconds until one frees up.
 * The count and the insert are one statement, so concurrent requests cannot all pass the check.
 * A reserved row stays as the failure record; a successful attempt deletes the rows.
 */
export async function reserveAttempt(db: D1Database, scope: string, now: number) {
  const since = now - LOCKOUT_WINDOW_MS;
  const [, reserved] = await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE scope = ? AND created_at <= ?").bind(scope, since),
    db
      .prepare(
        "INSERT INTO login_attempts (scope, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM login_attempts WHERE scope = ? AND created_at > ?) < ?",
      )
      .bind(scope, now, scope, since, LOCKOUT_FAILURES),
  ]);
  if (reserved?.meta.changes === 1) return 0;
  const oldest = await db
    .prepare("SELECT MIN(created_at) AS t FROM login_attempts WHERE scope = ? AND created_at > ?")
    .bind(scope, since)
    .first<number | null>("t");
  return Math.max(1, Math.ceil(((oldest ?? now) + LOCKOUT_WINDOW_MS - now) / 1000));
}

export function clearFailures(db: D1Database, scope: string) {
  return db.prepare("DELETE FROM login_attempts WHERE scope = ?").bind(scope);
}
