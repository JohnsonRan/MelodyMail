// The gap tool's Worker (worker/scripts/backup-gap.ts starts it with `wrangler dev`): the only
// way to list R2 with its custom metadata, since wrangler has no list command. GET /gap?since=<ms>
// answers the report and the SQL as JSON; it reads D1 and R2 and writes nothing. It is never
// deployed: its config has no routes and the tool runs it only under `wrangler dev`.
import { findGap, gapSql } from "../src/backup/gap";

type GapEnv = { MAIL: R2Bucket; DB: D1Database };

export default {
  async fetch(request: Request, env: GapEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    const since = Number(url.searchParams.get("since"));
    if (url.pathname !== "/gap" || !Number.isSafeInteger(since)) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const report = await findGap(env, since);
    return Response.json({ ...report, sql: gapSql(report.rows) });
  },
};
