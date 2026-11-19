import type { Context, Hono } from "hono";
import type { AppEnv } from "../env";
import { clientInfo, fail, readJson } from "../http";
import { flagStatement, parseFlags, SESSION_FLAGS, updateMessageFlags } from "./flags";
import { countStatement, FOLDER_PATCH_MAX, folderTarget, isDeletable, isFolder } from "./folders";
import { BULK_MAX, parseAddress, validId } from "./routes";
import { deletePermanently, purgeFolder } from "./trash";

// The bulk session routes of docs/M8-mailbox-ux.md, sections 1 and 2: changes and permanent
// deletes for listed ids or for a whole folder below a watermark. Session routes only (decision
// 5); the REST API keeps its own ids-only PATCH (worker/src/api/v1.ts).

type Ctx = Context<AppEnv>;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A list of 1 to BULK_MAX ids, or the error code to answer. */
function parseIds(value: unknown): string[] | "bad_request" | "too_many_ids" {
  if (!Array.isArray(value) || value.length === 0 || !value.every(validId)) return "bad_request";
  return value.length > BULK_MAX ? "too_many_ids" : value;
}

/**
 * PATCH /api/messages. With `ids`, Report spam and Not spam learn and forget the senders. With
 * `{ folder, address?, watermark, after? }` it changes at most FOLDER_PATCH_MAX rows of the view
 * at or below the watermark and below `after`, highest seq first, and answers `next`, the lowest
 * seq it changed, until no row is left; that form changes flags only ("Move to Spam").
 */
async function patchMessages(c: Ctx) {
  const body = await readJson(c);
  const flags = body && parseFlags(body, SESSION_FLAGS);
  if (!body || !flags) return fail(c, 400, "bad_request");
  if (body.folder === undefined) {
    const ids = parseIds(body.ids);
    if (typeof ids === "string") return fail(c, 400, ids);
    // A repeated id matches its row once: IN (json_each) is a set test.
    const result = await updateMessageFlags(c.env, ids, flags, { learn: true });
    return c.json({ updated: result.meta.changes });
  }
  const { folder, address, watermark, after } = body;
  if (
    body.ids !== undefined ||
    !isFolder(folder) ||
    (address !== undefined && !Number.isSafeInteger(address)) ||
    !isCount(watermark) ||
    (after !== undefined && !isCount(after))
  ) {
    return fail(c, 400, "bad_request");
  }
  const target = folderTarget(folder, address as number | undefined, watermark, after);
  const { results } = await flagStatement(c.env.DB, target, flags, Date.now(), "seq").all<{
    seq: number;
  }>();
  const lowest = results.reduce((min, r) => Math.min(min, r.seq), Number.POSITIVE_INFINITY);
  return c.json({
    updated: results.length,
    next: results.length < FOLDER_PATCH_MAX ? null : lowest,
  });
}

/** DELETE /api/messages: the listed ids that are in Trash or Spam now; others are skipped. */
async function deleteMessages(c: Ctx) {
  const body = await readJson(c);
  if (!body || !isDeletable(body.folder)) return fail(c, 400, "bad_request");
  const ids = parseIds(body.ids);
  if (typeof ids === "string") return fail(c, 400, ids);
  const { deleted } = await deletePermanently(c.env, body.folder, ids, {
    audit: { event: "messages_deleted", now: Date.now(), client: clientInfo(c) },
  });
  return c.json({ deleted });
}

/**
 * POST /api/messages/purge: one call of Empty Trash or Empty Spam. Every call of a loop sends the
 * watermark and asOf the count route gave when the dialog opened, so only what was in the folder
 * then is deleted.
 */
async function purge(c: Ctx) {
  const body = await readJson(c);
  if (
    !body ||
    !isDeletable(body.folder) ||
    (body.address !== undefined && !Number.isSafeInteger(body.address)) ||
    !isCount(body.watermark) ||
    !isCount(body.asOf)
  ) {
    return fail(c, 400, "bad_request");
  }
  const folder = body.folder;
  const bounds = {
    addressId: body.address as number | undefined,
    watermark: body.watermark,
    before: body.asOf,
  };
  const event = folder === "trash" ? "trash_emptied" : "spam_emptied";
  const result = await purgeFolder(c.env, folder, bounds, {
    event,
    now: Date.now(),
    client: clientInfo(c),
  });
  return c.json(result);
}

/** GET /api/messages/count: the view's rows at or below the watermark, and the server time. */
async function count(c: Ctx) {
  const folder = c.req.query("folder") ?? "inbox";
  const addressId = parseAddress(c.req.query("address"));
  if (!isFolder(folder) || addressId === null) return fail(c, 400, "bad_request");
  // Taken before the read: a message entering the folder after it has a later clock and is kept.
  const asOf = Date.now();
  const row = await countStatement(c.env.DB, folder, addressId).first<{
    watermark: number;
    total: number;
  }>();
  return c.json({ total: row?.total ?? 0, watermark: row?.watermark ?? 0, asOf });
}

export function registerBulkRoutes(messages: Hono<AppEnv>): void {
  messages.patch("/", patchMessages);
  messages.delete("/", deleteMessages);
  messages.post("/purge", purge);
  messages.get("/count", count);
}
