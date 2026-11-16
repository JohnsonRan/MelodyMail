import type { Context } from "hono";
import type { AppEnv } from "../env";
import {
  byteLength,
  clientId,
  HTML_MAX,
  hasLineBreak,
  isEmail,
  prefixSubject,
  RECIPIENTS_MAX,
  references,
  SUBJECT_MAX_BYTES,
  stringList,
  TEXT_MAX,
  TOTAL_MAX,
  UPLOADS_MAX,
} from "./validate";

// Step 1 of sending (docs/M5-sending.md, "Sending"): the request body checked and turned into
// the sent copy. The copy is what goes to R2 and, on a retry, to Resend again unchanged.

export type SentCopy = {
  from: string;
  addressId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The Markdown source as written (owner ruling 2026-11-16). */
  text: string;
  /** The browser's sanitized rendering of the Markdown, or null. */
  html: string | null;
  headers: Record<string, string>;
  attachments: { uploadId: string; filename: string; contentType: string; size: number }[];
};

export type Prepared = { copy: SentCopy; threadKey: string | null; sourceKind: string | null };

export type Refusal = { status: 400 | 413 | 503; error: string };

const KINDS = ["reply", "replyAll", "forward"] as const;
type Kind = (typeof KINDS)[number];

type FromRow = { address: string; displayName: string; enabled: number; sendEnabled: number };
type SourceRow = {
  messageId: string | null;
  references: string | null;
  threadKey: string | null;
};
type UploadRow = { id: string; filename: string; contentType: string; size: number };

/** A From header: the display name quoted, so commas and other specials stay inside it. */
function fromHeader(address: string, name: string): string {
  return name ? `"${name.replace(/["\\]/g, "\\$&")}" <${address}>` : address;
}

function recipients(body: Record<string, unknown>) {
  const to = stringList(body.to, RECIPIENTS_MAX);
  const cc = stringList(body.cc, RECIPIENTS_MAX);
  const bcc = stringList(body.bcc, RECIPIENTS_MAX);
  if (!to || !cc || !bcc) return { error: "invalid_recipient" } as const;
  const all = [...to, ...cc, ...bcc];
  if (all.length === 0) return { error: "no_recipients" } as const;
  if (all.length > RECIPIENTS_MAX) return { error: "too_many_recipients" } as const;
  if (!all.every(isEmail)) return { error: "invalid_recipient" } as const;
  return { to, cc, bcc };
}

export async function prepare(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Promise<Prepared | Refusal> {
  const db = c.env.DB;
  const addressId = body.fromAddressId;
  if (!Number.isSafeInteger(addressId)) return { status: 400, error: "unknown_address" };
  const from = await db
    .prepare(
      `SELECT a.local_part || '@' || a.domain AS address, a.display_name AS displayName,
         a.enabled, d.send_enabled AS sendEnabled
       FROM addresses a JOIN domains d ON d.name = a.domain WHERE a.id = ?`,
    )
    .bind(addressId)
    .first<FromRow>();
  if (!from) return { status: 400, error: "unknown_address" };
  if (!from.enabled) return { status: 400, error: "address_disabled" };
  if (!from.sendEnabled) return { status: 400, error: "sending_disabled" };
  if (hasLineBreak(from.displayName)) return { status: 400, error: "bad_request" };

  const list = recipients(body);
  if ("error" in list) return { status: 400, error: list.error as string };

  const { subject = "", text = "", html = null } = body;
  if (typeof subject !== "string" || byteLength(subject) > SUBJECT_MAX_BYTES) {
    return { status: 400, error: "invalid_subject" };
  }
  if (hasLineBreak(subject)) return { status: 400, error: "invalid_subject" };
  if (typeof text !== "string" || text.length > TEXT_MAX)
    return { status: 400, error: "bad_request" };
  if (html !== null && (typeof html !== "string" || html.length > HTML_MAX)) {
    return { status: 400, error: "bad_request" };
  }

  // The source of a reply or forward, for the thread headers and the subject prefix.
  const headers: Record<string, string> = {};
  let threadKey: string | null = null;
  let finalSubject = subject;
  const kind = (KINDS as readonly unknown[]).includes(body.sourceKind)
    ? (body.sourceKind as Kind)
    : null;
  if (body.sourceId !== undefined && body.sourceId !== null) {
    const sourceId = clientId(body.sourceId);
    const source =
      sourceId &&
      kind &&
      (await db
        .prepare(
          `SELECT message_id_hdr AS messageId, references_hdr AS "references",
             thread_key AS threadKey FROM messages WHERE id = ?`,
        )
        .bind(sourceId)
        .first<SourceRow>());
    if (!source || !kind) return { status: 400, error: "unknown_source" };
    finalSubject = prefixSubject(subject, kind);
    if (kind !== "forward") {
      threadKey = source.threadKey ?? sourceId;
      if (source.messageId) {
        headers["In-Reply-To"] = source.messageId;
        headers.References = references(source.references, source.messageId);
      }
    }
  }
  if (Object.values(headers).some(hasLineBreak) || byteLength(finalSubject) > SUBJECT_MAX_BYTES) {
    return { status: 400, error: "invalid_subject" };
  }

  const attachments = await attachedUploads(c, body.uploadIds);
  if ("status" in attachments) return attachments;

  return {
    copy: {
      from: fromHeader(from.address, from.displayName),
      addressId: addressId as number,
      ...list,
      subject: finalSubject,
      text,
      html: html as string | null,
      headers,
      attachments,
    },
    threadKey,
    sourceKind: kind,
  };
}

async function attachedUploads(
  c: Context<AppEnv>,
  value: unknown,
): Promise<SentCopy["attachments"] | Refusal> {
  if (value === undefined || value === null) return [];
  const ids = stringList(value, UPLOADS_MAX, 64);
  if (ids === null || !ids.every(clientId) || new Set(ids).size !== ids.length) {
    return { status: 400, error: "unknown_upload" };
  }
  if (ids.length === 0) return [];
  if (!c.env.UPLOAD_URL_KEY) return { status: 503, error: "attachments_not_configured" };
  const { results } = await c.env.DB.prepare(
    `SELECT id, filename, content_type AS contentType, size FROM uploads
     WHERE id IN (SELECT value FROM json_each(?)) AND message_id IS NULL`,
  )
    .bind(JSON.stringify(ids))
    .all<UploadRow>();
  if (results.length !== ids.length) return { status: 400, error: "unknown_upload" };
  if (results.reduce((sum, u) => sum + u.size, 0) > TOTAL_MAX) {
    return { status: 413, error: "attachments_too_large" };
  }
  // In the order the owner attached them.
  return ids.map((id) => {
    const u = results.find((r) => r.id === id) as UploadRow;
    return { uploadId: u.id, filename: u.filename, contentType: u.contentType, size: u.size };
  });
}
