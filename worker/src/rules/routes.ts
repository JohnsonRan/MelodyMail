import type { Hono } from "hono";
import { unknownTargets } from "../addresses/targets";
import { audit } from "../auth/store";
import { parseId } from "../domains/validate";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import { parseRecipient } from "../mail/inbound";
import { SLICE_BYTES } from "../mail/parse";
import {
  conditionMatches,
  evaluateRules,
  FieldReader,
  type MailSource,
  type Rule,
  ruleMatches,
} from "./evaluate";
import { parseRule, RULES_MAX, type RuleInput } from "./validate";

// Settings > Rules (docs/M6-rules-api.md, "Routes added or changed"). Session routes only: no API
// key reaches them. Audit rows name rule ids, never condition values. Changing a rule changes no
// stored message (Decision 4).

type RuleRow = {
  id: number;
  name: string;
  enabled: number;
  position: number;
  match: "all" | "any";
  conditions: string;
  markRead: number;
  star: number;
  archive: number;
  trash: number;
  stop: number;
  targetIds: string;
  createdAt: number;
  updatedAt: number;
};

const SELECT_RULES = `SELECT id, name, enabled, position, match, conditions, mark_read AS markRead,
  star, archive, trash, stop, created_at AS createdAt, updated_at AS updatedAt,
  (SELECT json_group_array(target_id) FROM rule_forwards f WHERE f.rule_id = rules.id) AS targetIds
  FROM rules`;

const toRule = (r: RuleRow) => ({
  ...r,
  enabled: r.enabled === 1,
  conditions: JSON.parse(r.conditions) as unknown[],
  markRead: r.markRead === 1,
  star: r.star === 1,
  archive: r.archive === 1,
  trash: r.trash === 1,
  stop: r.stop === 1,
  targetIds: (JSON.parse(r.targetIds) as number[]).sort((x, y) => x - y),
});

const bit = (v: boolean) => (v ? 1 : 0);

function columns(r: RuleInput) {
  return [
    r.name,
    bit(r.enabled),
    r.match,
    JSON.stringify(r.conditions),
    bit(r.markRead),
    bit(r.star),
    bit(r.archive),
    bit(r.trash),
    bit(r.stop),
  ];
}

/** The header block of a raw message (up to its first empty line), as Headers.get reads it. */
export function headersFromRaw(bytes: Uint8Array): MailSource["headers"] {
  const text = new TextDecoder().decode(bytes);
  const end = text.search(/\r?\n\r?\n/);
  const block = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n(?=[ \t])/g, "");
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers.get(name);
    headers.set(name, prev === undefined ? value : `${prev}, ${value}`);
  }
  return { get: (name) => headers.get(name.toLowerCase()) ?? null };
}

export function registerRuleRoutes(rules: Hono<AppEnv>): void {
  rules.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `${SELECT_RULES} ORDER BY position, id`,
    ).all<RuleRow>();
    return c.json({ rules: results.map(toRule) });
  });

  rules.post("/", async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const rule = parseRule(body);
    if (!rule.ok) return fail(c, 400, rule.error);
    const db = c.env.DB;
    if (await unknownTargets(db, rule.value.targetIds)) return fail(c, 400, "unknown_target");
    const now = Date.now();
    // The count check and the insert are one statement, so two requests cannot pass 50. The
    // links use the new row's id only when that insert happened (changes() is its row count).
    const [inserted] = await db.batch<{ id: number }>([
      db
        .prepare(
          `INSERT INTO rules (name, enabled, match, conditions, mark_read, star, archive, trash,
             stop, position, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(top, 0) + 1, ?, ?
             FROM (SELECT COUNT(*) AS n, MAX(position) AS top FROM rules) WHERE n < ?
           RETURNING id`,
        )
        .bind(...columns(rule.value), now, now, RULES_MAX),
      db
        .prepare(
          `INSERT INTO rule_forwards (rule_id, target_id)
           SELECT last_insert_rowid(), id FROM forward_targets
            WHERE changes() = 1 AND id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(rule.value.targetIds)),
    ]);
    const id = inserted?.results[0]?.id;
    if (id === undefined) return fail(c, 409, "too_many_rules");
    await audit(c, "rule_created", now, `rule ${id}`).run();
    const row = await db.prepare(`${SELECT_RULES} WHERE id = ?`).bind(id).first<RuleRow>();
    return c.json({ rule: row && toRule(row) }, 201);
  });

  // Registered before "/:id". Every rule id exactly once; anything else is order_mismatch. One
  // statement checks the set and writes the positions.
  rules.put("/order", async (c) => {
    const body = await readJson(c);
    const ids = body?.ids;
    if (!Array.isArray(ids) || !ids.every((v) => Number.isSafeInteger(v) && v > 0)) {
      return fail(c, 400, "bad_request");
    }
    if (new Set(ids).size !== ids.length) return fail(c, 409, "order_mismatch");
    const list = JSON.stringify(ids);
    const { meta } = await c.env.DB.prepare(
      `UPDATE rules SET position = (SELECT key + 1 FROM json_each(?1) WHERE value = rules.id)
        WHERE (SELECT COUNT(*) FROM rules) = json_array_length(?1)
          AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.id NOT IN (SELECT value FROM json_each(?1)))`,
    )
      .bind(list)
      .run();
    if (meta.changes !== ids.length) return fail(c, 409, "order_mismatch");
    await audit(c, "rules_reordered", Date.now(), ids.join(",")).run();
    return c.json({ ok: true });
  });

  // An unsaved rule against one stored inbound message: the same evaluateRules that email()
  // runs, over the header block of the first 64 KB (the consumer's range read). Changes nothing.
  rules.post("/test", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.messageId !== "string" || body.messageId.length > 64) {
      return fail(c, 400, "bad_request");
    }
    const ruleBody = body.rule;
    if (ruleBody === null || typeof ruleBody !== "object" || Array.isArray(ruleBody)) {
      return fail(c, 400, "bad_request");
    }
    const input = parseRule(ruleBody as Record<string, unknown>, true);
    if (!input.ok) return fail(c, 400, input.error);
    const db = c.env.DB;
    const ids = JSON.stringify(input.value.targetIds);
    const [message, targets] = await db.batch([
      db
        .prepare(
          "SELECT direction, envelope_from AS envelopeFrom, envelope_to AS envelopeTo, r2_key AS key FROM messages WHERE id = ?",
        )
        .bind(body.messageId),
      db
        .prepare(
          "SELECT email FROM forward_targets WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
        )
        .bind(ids),
    ]);
    const row = message?.results[0] as
      | { direction: string; envelopeFrom: string; envelopeTo: string; key: string }
      | undefined;
    if (!row) return fail(c, 404, "not_found");
    const emails = (targets?.results ?? []).map((t) => (t as { email: string }).email);
    if (emails.length !== input.value.targetIds.length) return fail(c, 400, "unknown_target");
    const recipient = parseRecipient(row.envelopeTo);
    const object =
      row.direction === "in" && recipient
        ? await c.env.MAIL.get(row.key, { range: { offset: 0, length: SLICE_BYTES } })
        : null;
    if (!object || !recipient) return fail(c, 409, "no_raw");
    const source: MailSource = {
      envelopeFrom: row.envelopeFrom,
      headers: headersFromRaw(new Uint8Array(await object.arrayBuffer())),
      recipient: `${recipient.localPart}@${recipient.domain}`,
      tag: recipient.tag,
    };
    const rule: Rule = { ...input.value, targets: emails };
    const reader = new FieldReader(source);
    const decision = evaluateRules([rule], source);
    const matched = ruleMatches(rule, reader);
    return c.json({
      matched,
      conditions: rule.conditions.map((cond) => ({ matched: conditionMatches(cond, reader) })),
      markRead: decision.read,
      star: decision.starred,
      archive: decision.archived,
      trash: decision.trashed,
      stop: matched && rule.stop,
      targets: decision.targets,
    });
  });

  rules.put("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return fail(c, 404, "not_found");
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const rule = parseRule(body);
    if (!rule.ok) return fail(c, 400, rule.error);
    const db = c.env.DB;
    if (await unknownTargets(db, rule.value.targetIds)) return fail(c, 400, "unknown_target");
    const now = Date.now();
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE rules SET name = ?, enabled = ?, match = ?, conditions = ?, mark_read = ?,
             star = ?, archive = ?, trash = ?, stop = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(...columns(rule.value), now, id),
      db.prepare("DELETE FROM rule_forwards WHERE rule_id = ?").bind(id),
      db
        .prepare(
          `INSERT INTO rule_forwards (rule_id, target_id)
           SELECT r.id, t.id FROM rules r JOIN forward_targets t
               ON t.id IN (SELECT value FROM json_each(?)) WHERE r.id = ?`,
        )
        .bind(JSON.stringify(rule.value.targetIds), id),
    ]);
    if (!updated?.meta.changes) return fail(c, 404, "not_found");
    await audit(c, "rule_updated", now, `rule ${id}`).run();
    const row = await db.prepare(`${SELECT_RULES} WHERE id = ?`).bind(id).first<RuleRow>();
    return c.json({ rule: row && toRule(row) });
  });

  rules.delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return fail(c, 404, "not_found");
    const { meta } = await c.env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
    if (!meta.changes) return fail(c, 404, "not_found");
    await audit(c, "rule_deleted", Date.now(), `rule ${id}`).run();
    return c.json({ ok: true });
  });
}
