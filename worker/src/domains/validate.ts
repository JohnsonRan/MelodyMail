// Boundary validation for domains, addresses and forwarding targets. Each parser returns the
// normalized value, or an error code for the `{ error }` answer.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = (error: string): Parsed<never> => ({ ok: false, error });

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A domain name in lowercase ASCII. Non-ASCII input is refused rather than converted to
 * punycode: the owner enters the xn-- form, so the stored name is exactly what DNS holds.
 */
export function parseDomain(value: unknown): Parsed<string> {
  if (typeof value !== "string") return err("invalid_domain");
  const name = value.trim().replace(/\.$/, "").toLowerCase();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the point
  if (/[^\x00-\x7f]/.test(name)) return err("domain_not_ascii");
  if (name.length === 0 || name.length > 253) return err("invalid_domain");
  const labels = name.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return err("invalid_domain");
  if (/^\d+$/.test(labels.at(-1) ?? "")) return err("invalid_domain");
  return ok(name);
}

/**
 * The part before "@", lowercased (prefixes are case-insensitive). Allowed: a-z 0-9 . _ -
 * with no leading, trailing or doubled dot. "+" is refused: it separates the sub-address tag.
 */
export function parseLocalPart(value: unknown): Parsed<string> {
  if (typeof value !== "string") return err("invalid_local_part");
  const local = value.trim().toLowerCase();
  if (local.length === 0 || local.length > 64) return err("invalid_local_part");
  if (!/^[a-z0-9._-]+$/.test(local)) return err("invalid_local_part");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return err("invalid_local_part");
  }
  return ok(local);
}

/** A forwarding target, stored lowercase so that one mailbox is listed once. */
export function parseEmail(value: unknown): Parsed<string> {
  if (typeof value !== "string") return err("invalid_email");
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  if (at < 1 || local.length > 64 || !/^[!#-'*-+\-./0-9=?^-~]+$/.test(local)) {
    return err("invalid_email");
  }
  const domain = parseDomain(email.slice(at + 1));
  return domain.ok ? ok(`${local}@${domain.value}`) : err("invalid_email");
}

/** Optional free text: absent gives undefined; too long or control characters is an error. */
export function parseText(
  value: unknown,
  maxLength: number,
  error: string,
): Parsed<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string") return err(error);
  const text = value.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  if (text.length > maxLength || /[\x00-\x1f\x7f]/.test(text)) return err(error);
  return ok(text);
}

export function parseFlag(value: unknown): Parsed<boolean | undefined> {
  if (value === undefined || typeof value === "boolean") return ok(value);
  return err("bad_request");
}

/** A switch for SQL: undefined leaves the column as it is (COALESCE). */
export const asInt = (flag: boolean | undefined) => (flag === undefined ? null : Number(flag));

/** Longest note on an address or a forwarding target. */
export const NOTE_MAX = 200;

const MAX_TARGETS_PER_ADDRESS = 50;

/** Optional list of forwarding target ids, deduplicated. */
export function parseIds(value: unknown): Parsed<number[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.length > MAX_TARGETS_PER_ADDRESS) return err("bad_request");
  if (!value.every((v) => Number.isSafeInteger(v) && v > 0)) return err("bad_request");
  return ok([...new Set(value as number[])]);
}

/** A positive integer path id, or null. */
export function parseId(value: string): number | null {
  return /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
}
