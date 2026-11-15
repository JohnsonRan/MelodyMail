// Strict lockout for POST /api/auth/recover, counted in D1 because the Rate Limiting binding is
// approximate. Way out: the window passes, or the owner runs
// `wrangler d1 execute melodymail --remote --command "DELETE FROM login_attempts"`.
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;

/**
 * Returns the seconds until recovery opens again, or 0 when it is open. Recovery locks for
 * 15 minutes from the latest failure once the latest 5 failures fall within 15 minutes.
 */
export async function lockedForSeconds(db: D1Database, scope: string, now: number) {
  const { results } = await db
    .prepare(
      "SELECT created_at AS createdAt FROM login_attempts WHERE scope = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(scope, LOCKOUT_FAILURES)
    .all<{ createdAt: number }>();
  const latest = results[0]?.createdAt;
  const oldest = results[LOCKOUT_FAILURES - 1]?.createdAt;
  if (latest === undefined || oldest === undefined) return 0;
  if (latest - oldest >= LOCKOUT_WINDOW_MS) return 0;
  const until = latest + LOCKOUT_WINDOW_MS;
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

export function recordFailure(db: D1Database, scope: string, now: number) {
  return db.batch([
    db.prepare("INSERT INTO login_attempts (scope, created_at) VALUES (?, ?)").bind(scope, now),
    // Only the latest few rows matter; keep the table small.
    db
      .prepare("DELETE FROM login_attempts WHERE scope = ? AND created_at < ?")
      .bind(scope, now - 2 * LOCKOUT_WINDOW_MS),
  ]);
}

export function clearFailures(db: D1Database, scope: string) {
  return db.prepare("DELETE FROM login_attempts WHERE scope = ?").bind(scope);
}
