import type { Hono } from "hono";
import { audit } from "../auth/store";
import {
  asInt,
  NOTE_MAX,
  type Parsed,
  parseDomain,
  parseFlag,
  parseId,
  parseIds,
  parseLocalPart,
  parseText,
} from "../domains/validate";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import { forwardsInsert, keepForwardOnlyTargeted, unknownTargets } from "./targets";

type AddressRow = {
  id: number;
  localPart: string;
  domain: string;
  note: string;
  displayName: string;
  enabled: number;
  forwardOnly: number;
  lastReceivedAt: number | null;
  createdAt: number;
  targetIds: string;
};

const SELECT_ADDRESSES =
  "SELECT a.id, a.local_part AS localPart, a.domain, a.note, a.display_name AS displayName, a.enabled, a.forward_only AS forwardOnly, a.last_received_at AS lastReceivedAt, a.created_at AS createdAt, (SELECT json_group_array(f.target_id) FROM address_forwards f WHERE f.address_id = a.id) AS targetIds FROM addresses a";

const toAddress = (r: AddressRow) => ({
  ...r,
  address: `${r.localPart}@${r.domain}`,
  enabled: r.enabled === 1,
  forwardOnly: r.forwardOnly === 1,
  targetIds: (JSON.parse(r.targetIds) as number[]).sort((x, y) => x - y),
});

const DISPLAY_NAME_MAX = 100;

type Fields = {
  note?: string;
  displayName?: string;
  enabled?: boolean;
  forwardOnly?: boolean;
  targetIds?: number[];
};

/** The editable fields shared by create and update; absent fields stay undefined. */
function parseFields(body: Record<string, unknown>): Parsed<Fields> {
  const note = parseText(body.note, NOTE_MAX, "invalid_note");
  if (!note.ok) return note;
  // The default sender name becomes a From header when sending arrives (M5).
  const displayName = parseText(body.displayName, DISPLAY_NAME_MAX, "invalid_display_name");
  if (!displayName.ok) return displayName;
  const enabled = parseFlag(body.enabled);
  if (!enabled.ok) return enabled;
  const forwardOnly = parseFlag(body.forwardOnly);
  if (!forwardOnly.ok) return forwardOnly;
  const targetIds = parseIds(body.targetIds);
  if (!targetIds.ok) return targetIds;
  return {
    ok: true,
    value: {
      note: note.value,
      displayName: displayName.value,
      enabled: enabled.value,
      forwardOnly: forwardOnly.value,
      targetIds: targetIds.value,
    },
  };
}

/** Settings > Addresses. Guarded by the session middleware like every non-public route. */
export function registerAddressRoutes(addresses: Hono<AppEnv>): void {
  addresses.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `${SELECT_ADDRESSES} ORDER BY a.domain, a.local_part`,
    ).all<AddressRow>();
    return c.json({ addresses: results.map(toAddress) });
  });

  addresses.post("/", async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const local = parseLocalPart(body.localPart);
    if (!local.ok) return fail(c, 400, local.error);
    const domain = parseDomain(body.domain);
    if (!domain.ok) return fail(c, 400, domain.error);
    const parsed = parseFields(body);
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const fields = parsed.value;
    const targetIds = fields.targetIds ?? [];
    // An address set to forward only, with nowhere to forward, would drop every message.
    if (fields.forwardOnly && targetIds.length === 0) {
      return fail(c, 400, "forward_only_needs_target");
    }
    const db = c.env.DB;
    const known = await db
      .prepare("SELECT 1 AS one FROM domains WHERE name = ?")
      .bind(domain.value)
      .first();
    if (!known) return fail(c, 400, "unknown_domain");
    if (await unknownTargets(db, targetIds)) return fail(c, 400, "unknown_target");
    const now = Date.now();
    const address = `${local.value}@${domain.value}`;
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO addresses (local_part, domain, note, display_name, enabled, forward_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            local.value,
            domain.value,
            fields.note ?? "",
            fields.displayName ?? "",
            asInt(fields.enabled ?? true),
            asInt(fields.forwardOnly ?? false),
            now,
          ),
        forwardsInsert(db, domain.value, local.value, targetIds),
        // A target removed after the check above leaves no link to insert.
        keepForwardOnlyTargeted(db, domain.value, local.value),
        audit(c, "address_added", now, address),
      ]);
    } catch (err) {
      // The (domain, local_part) unique index refused it; the batch rolled back as a whole.
      const exists = await db
        .prepare("SELECT 1 AS one FROM addresses WHERE domain = ? AND local_part = ?")
        .bind(domain.value, local.value)
        .first();
      if (exists) return fail(c, 409, "address_exists");
      throw err;
    }
    const row = await db
      .prepare(`${SELECT_ADDRESSES} WHERE a.domain = ? AND a.local_part = ?`)
      .bind(domain.value, local.value)
      .first<AddressRow>();
    return c.json({ address: row && toAddress(row) }, 201);
  });

  addresses.patch("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const parsed = parseFields(body);
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const fields = parsed.value;
    const db = c.env.DB;
    const current =
      id === null
        ? null
        : await db.prepare(`${SELECT_ADDRESSES} WHERE a.id = ?`).bind(id).first<AddressRow>();
    if (!current) return fail(c, 404, "not_found");
    // Checked only when this request turns forward-only on or replaces the targets, so a row an
    // earlier build left forward-only without targets can still be edited (the batch below then
    // switches it back to store and forward).
    const forwardOnly = fields.forwardOnly ?? current.forwardOnly === 1;
    const targetIds = fields.targetIds ?? toAddress(current).targetIds;
    const changesForwarding = fields.forwardOnly === true || fields.targetIds !== undefined;
    if (changesForwarding && forwardOnly && targetIds.length === 0) {
      return fail(c, 400, "forward_only_needs_target");
    }
    if (fields.targetIds && (await unknownTargets(db, fields.targetIds))) {
      return fail(c, 400, "unknown_target");
    }
    const steps = [
      db
        .prepare(
          "UPDATE addresses SET note = COALESCE(?, note), display_name = COALESCE(?, display_name), enabled = COALESCE(?, enabled), forward_only = COALESCE(?, forward_only) WHERE id = ?",
        )
        .bind(
          fields.note ?? null,
          fields.displayName ?? null,
          asInt(fields.enabled),
          asInt(fields.forwardOnly),
          current.id,
        ),
    ];
    if (fields.targetIds) {
      steps.push(
        db.prepare("DELETE FROM address_forwards WHERE address_id = ?").bind(current.id),
        forwardsInsert(db, current.domain, current.localPart, fields.targetIds),
      );
    }
    steps.push(keepForwardOnlyTargeted(db, current.domain, current.localPart));
    await db.batch(steps);
    const row = await db
      .prepare(`${SELECT_ADDRESSES} WHERE a.id = ?`)
      .bind(current.id)
      .first<AddressRow>();
    return c.json({ address: row && toAddress(row) });
  });

  // The UI confirms first: it cannot be undone. Target links go with the address (cascade).
  addresses.delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return fail(c, 404, "not_found");
    const now = Date.now();
    const removed = await c.env.DB.prepare(
      "DELETE FROM addresses WHERE id = ? RETURNING local_part AS localPart, domain",
    )
      .bind(id)
      .first<{ localPart: string; domain: string }>();
    if (!removed) return fail(c, 404, "not_found");
    await audit(c, "address_removed", now, `${removed.localPart}@${removed.domain}`).run();
    return c.json({ ok: true });
  });
}
