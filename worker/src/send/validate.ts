// Limits and input checks for sending (docs/M5-sending.md, "Routes" and "Sending").

const MIB = 1024 * 1024;
/** Per file, raw. */
export const FILE_MAX = 25 * MIB;
/** All attachments of one message, raw: about 40 MB after base64, Resend's limit per email. */
export const TOTAL_MAX = 30 * MIB;
export const RECIPIENTS_MAX = 50;
export const SUBJECT_MAX_BYTES = 998;
/** The Markdown source and its HTML rendering. */
export const TEXT_MAX = 512 * 1024;
export const HTML_MAX = 2 * MIB;
export const UPLOADS_MAX = 20;
const ADDRESS_MAX = 254;
const FILENAME_MAX = 255;

const encoder = new TextEncoder();

export const byteLength = (value: string) => encoder.encode(value).byteLength;

/** CR or LF would end a header and start another one (header injection). */
export const hasLineBreak = (value: string) => /[\r\n]/.test(value);

/** A bare address as the compose chips hold it: no display name, no comments. */
export function isEmail(value: string): boolean {
  return (
    value.length <= ADDRESS_MAX &&
    /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\.]{2,}$/.test(value)
  );
}

/** The client's key for one compose session; Resend keeps it for 24 hours. */
export function idempotencyKey(value: unknown): string | null {
  return typeof value === "string" && /^[\w.:-]{8,256}$/.test(value) ? value : null;
}

/** Ids the browser or this Worker chose (UUIDs). */
export function clientId(value: unknown): string | null {
  return typeof value === "string" && /^[\w-]{8,64}$/.test(value) ? value : null;
}

/** A list of strings, or null when the value is not one (or is too long). */
export function stringList(value: unknown, max: number, itemMax = ADDRESS_MAX): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > itemMax) return null;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/** A file name from the X-Filename header (percent-encoded UTF-8), or null. */
export function filename(header: string | undefined): string | null {
  if (!header) return null;
  let name: string;
  try {
    name = decodeURIComponent(header).trim();
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (!name || name.length > FILENAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function contentType(header: string | undefined): string {
  const value = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[\w.+-]{1,63}\/[\w.+-]{1,63}$/.test(value) ? value : "application/octet-stream";
}

/** "Re: " or "Fwd: " once (docs/M5-sending.md, "Sending", 3). */
export function prefixSubject(subject: string, kind: "reply" | "replyAll" | "forward"): string {
  if (kind === "forward") return /^\s*(fwd?|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** The References header of a reply: the source's References plus its Message-ID. */
export function references(sourceReferences: string | null, messageId: string): string {
  const ids = `${sourceReferences ?? ""} ${messageId}`.match(/<[^<>\s]+>/g) ?? [messageId];
  // A long thread keeps its first message and the newest ten, inside the 998-byte line limit.
  const kept = ids.length > 11 ? [ids[0], ...ids.slice(-10)] : ids;
  return kept.join(" ");
}
