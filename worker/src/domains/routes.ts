import type { Context, Hono } from "hono";
import { hasFreshAuth } from "../auth/session";
import { audit } from "../auth/store";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import { checkDns, DnsLookupError, expectedRecords } from "./dns";
import { asInt, parseDomain, parseFlag } from "./validate";

type DomainRow = {
  name: string;
  receiveEnabled: number;
  sendEnabled: number;
  createdAt: number;
  addressCount: number;
};

const SELECT_DOMAINS =
  "SELECT name, receive_enabled AS receiveEnabled, send_enabled AS sendEnabled, created_at AS createdAt, (SELECT COUNT(*) FROM addresses a WHERE a.domain = d.name) AS addressCount FROM domains d";

const toDomain = (r: DomainRow) => ({
  ...r,
  receiveEnabled: r.receiveEnabled === 1,
  sendEnabled: r.sendEnabled === 1,
});

/** The stored domain named in the path, or null. */
async function findDomain(c: Context<AppEnv>): Promise<DomainRow | null> {
  const parsed = parseDomain(c.req.param("name"));
  if (!parsed.ok) return null;
  return c.env.DB.prepare(`${SELECT_DOMAINS} WHERE name = ?`).bind(parsed.value).first<DomainRow>();
}

/** Settings > Domains. Guarded by the session middleware like every non-public route. */
export function registerDomainRoutes(domains: Hono<AppEnv>): void {
  domains.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(`${SELECT_DOMAINS} ORDER BY name`).all<DomainRow>();
    return c.json({ domains: results.map(toDomain) });
  });

  domains.post("/", async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const name = parseDomain(body.name);
    if (!name.ok) return fail(c, 400, name.error);
    const now = Date.now();
    const db = c.env.DB;
    const inserted = await db
      .prepare("INSERT INTO domains (name, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .bind(name.value, now)
      .run();
    if (inserted.meta.changes === 0) return fail(c, 409, "domain_exists");
    await audit(c, "domain_added", now, name.value).run();
    const row = await db
      .prepare(`${SELECT_DOMAINS} WHERE name = ?`)
      .bind(name.value)
      .first<DomainRow>();
    return c.json({ domain: row && toDomain(row) }, 201);
  });

  domains.patch("/:name", async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const receive = parseFlag(body.receiveEnabled);
    const send = parseFlag(body.sendEnabled);
    if (!receive.ok || !send.ok) return fail(c, 400, "bad_request");
    const domain = await findDomain(c);
    if (!domain) return fail(c, 404, "not_found");
    const db = c.env.DB;
    await db
      .prepare(
        "UPDATE domains SET receive_enabled = COALESCE(?, receive_enabled), send_enabled = COALESCE(?, send_enabled) WHERE name = ?",
      )
      .bind(asInt(receive.value), asInt(send.value), domain.name)
      .run();
    const row = await db
      .prepare(`${SELECT_DOMAINS} WHERE name = ?`)
      .bind(domain.name)
      .first<DomainRow>();
    return c.json({ domain: row && toDomain(row) });
  });

  // Refused while addresses use the domain, unless ?deleteAddresses=1 asks to delete them too
  // (the UI confirms first; it cannot be undone). That forced delete also needs step-up
  // re-authentication (owner ruling 2026-11-16); a plain delete does not.
  domains.delete("/:name", async (c) => {
    const domain = await findDomain(c);
    if (!domain) return fail(c, 404, "not_found");
    const db = c.env.DB;
    const now = Date.now();
    const force = c.req.query("deleteAddresses") === "1";
    if (force && !hasFreshAuth(c)) return fail(c, 403, "reauth_required");
    // One statement decides, so an address added concurrently is never orphaned; the foreign
    // key refuses it as well.
    const removeDomain = db
      .prepare(
        "DELETE FROM domains WHERE name = ? AND NOT EXISTS (SELECT 1 FROM addresses WHERE domain = ?)",
      )
      .bind(domain.name, domain.name);
    const steps = force
      ? [
          db.prepare("DELETE FROM addresses WHERE domain = ? RETURNING id").bind(domain.name),
          removeDomain,
        ]
      : [removeDomain];
    const results = await db.batch(steps);
    if (results.at(-1)?.meta.changes !== 1) return fail(c, 409, "domain_has_addresses");
    const removed = force ? (results[0]?.results.length ?? 0) : 0;
    await audit(c, "domain_removed", now, `${domain.name} (${removed} addresses)`).run();
    return c.json({ ok: true, deletedAddresses: removed });
  });

  domains.get("/:name/dns", async (c) => {
    const domain = await findDomain(c);
    if (!domain) return fail(c, 404, "not_found");
    return c.json(expectedRecords(domain.name));
  });

  domains.post("/:name/dns/check", async (c) => {
    const domain = await findDomain(c);
    if (!domain) return fail(c, 404, "not_found");
    try {
      return c.json({ records: await checkDns(c.env.DOH_URL, domain.name), checkedAt: Date.now() });
    } catch (e) {
      if (e instanceof DnsLookupError) return fail(c, 502, "dns_check_failed");
      throw e;
    }
  });
}
