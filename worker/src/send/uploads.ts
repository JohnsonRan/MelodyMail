import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { errorText, fail, log } from "../http";
import { publicRoute } from "../routing";
import { verifyUpload } from "./signed-url";
import { clientId, contentType, FILE_MAX, filename } from "./validate";

// Attachments (docs/M5-sending.md, "Routes"). The body is streamed into R2 by the runtime; no
// JS reads it. An upload belongs to a draft until it is sent, then to the sent message.

const uploadKey = (id: string) => `uploads/${id}`;

type UploadRow = { id: string; key: string; filename: string; contentType: string; size: number };

const DOWNLOAD_HEADERS = {
  "content-type": "application/octet-stream",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export function registerUploadRoutes(uploads: Hono<AppEnv>): void {
  uploads.put("/", async (c) => {
    if (!c.env.UPLOAD_URL_KEY) return fail(c, 503, "attachments_not_configured");
    const length = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(length) || length < 1 || !c.req.raw.body) {
      return fail(c, 400, "bad_request");
    }
    if (length > FILE_MAX) return fail(c, 413, "file_too_large");
    const name = filename(c.req.header("x-filename"));
    const draftHeader = c.req.header("x-draft-id");
    const draftId = draftHeader === undefined ? null : clientId(draftHeader);
    if (!name || (draftHeader !== undefined && !draftId)) return fail(c, 400, "bad_request");
    const type = contentType(c.req.header("content-type"));
    const id = crypto.randomUUID();
    const object = await c.env.MAIL.put(uploadKey(id), c.req.raw.body, {
      httpMetadata: { contentType: type },
    });
    await c.env.DB.prepare(
      `INSERT INTO uploads (id, r2_key, filename, content_type, size, created_at, draft_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, uploadKey(id), name, type, object.size, Date.now(), draftId)
      .run();
    return c.json({ upload: { id, filename: name, contentType: type, size: object.size } });
  });

  // The owner's own download of an attachment of a sent message or a draft.
  uploads.get("/:id", async (c) => {
    const row = await findUpload(c.env.DB, c.req.param("id"));
    const object = row && (await c.env.MAIL.get(row.key));
    if (!row || !object) return fail(c, 404, "not_found");
    return new Response(object.body, {
      headers: {
        ...DOWNLOAD_HEADERS,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        "content-length": String(object.size),
      },
    });
  });

  // Only an upload not yet sent; a sent message keeps its attachments.
  uploads.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const row = await c.env.DB.prepare(
      "DELETE FROM uploads WHERE id = ? AND message_id IS NULL RETURNING r2_key AS key",
    )
      .bind(id)
      .first<{ key: string }>();
    if (!row) {
      const exists = await findUpload(c.env.DB, id);
      return exists ? fail(c, 409, "upload_sent") : fail(c, 404, "not_found");
    }
    try {
      await c.env.MAIL.delete(row.key);
    } catch (err) {
      log("warn", "upload_delete_failed", { uploadId: id, error: errorText(err) });
    }
    return c.json({ ok: true });
  });
}

/**
 * Public: Resend fetches attachments here. Only a valid, unexpired signature over this id opens
 * it; every refusal is the same 403 without detail.
 */
export function registerUploadBlobRoute(app: Hono<AppEnv>): void {
  publicRoute(app, "GET", "/uploads/:id/blob", async (c) => {
    const secret = c.env.UPLOAD_URL_KEY;
    const id = c.req.param("id") ?? "";
    const nowS = Math.floor(Date.now() / 1000);
    if (
      !secret ||
      !(await verifyUpload(secret, id, c.req.query("exp"), c.req.query("sig"), nowS))
    ) {
      return fail(c, 403, "forbidden");
    }
    const row = await findUpload(c.env.DB, id);
    const object = row && (await c.env.MAIL.get(row.key));
    if (!row || !object) return fail(c, 404, "not_found");
    return new Response(object.body, {
      headers: { ...DOWNLOAD_HEADERS, "content-length": String(object.size) },
    });
  });
}

export function findUpload(db: D1Database, id: string): Promise<UploadRow | null> {
  return db
    .prepare(
      `SELECT id, r2_key AS key, filename, content_type AS contentType, size FROM uploads
       WHERE id = ?`,
    )
    .bind(id)
    .first<UploadRow>();
}
