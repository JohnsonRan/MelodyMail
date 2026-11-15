import PostalMime, { type Address, type Email } from "postal-mime";

/**
 * The bounded server-side parse (docs/PLAN.md, section 2, "CPU budget"): it only ever sees the
 * first SLICE_BYTES of a message, so its work does not grow with the message size. The browser
 * parses the full raw message (M4).
 */
export const SLICE_BYTES = 256 * 1024;
/**
 * Most messages carry their headers and first text part well inside this prefix. Parsing it
 * first costs about a quarter of a full pass over the slice (bench/parse.ts); the full slice is
 * parsed only when the prefix shows no text or HTML part.
 */
export const FIRST_PASS_BYTES = 64 * 1024;
export const TEXT_MAX = 8 * 1024;
export const SNIPPET_MAX = 200;
const HEADER_MAX = 998;
const ADDRESS_LIST_MAX = 2000;

// Limits on the parser's own work inside the slice. A message over them fails the parse and
// becomes parse_failed; the browser still reads it from the raw object.
const PARSER_OPTIONS = {
  maxNestingDepth: 32,
  maxPartCount: 500,
  maxHeadersSize: SLICE_BYTES,
  maxRfc822NestingDepth: 2,
};

export type ParsedHeaders = {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  date: string | null;
  hasAttachments: boolean;
  /** Text for search, at most TEXT_MAX characters. */
  text: string;
  snippet: string;
};

function cut(value: string | undefined, max: number): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}

function formatAddress(a: Address): string {
  if (a.group) return `${a.name}: ${a.group.map(formatAddress).join(", ")};`;
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function addressList(list: Address[] | undefined): string | null {
  return cut(list?.map(formatAddress).join(", "), ADDRESS_LIST_MAX);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const SKIPPED_ELEMENTS = /^<(script|style|head)[\s>/]/;

/**
 * A rough HTML-to-text reduction for search and the snippet; never rendered. The HTML comes
 * from the sender, so this is one forward scan with indexOf and no backtracking regex: each
 * search either moves past what it found or ends the scan. An unterminated tag, comment or
 * script, style or head element drops the rest of the input.
 */
function htmlToText(html: string, max: number): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length && out.length < max) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (!out.endsWith(" ")) out += " ";
    let end: number;
    if (lower.startsWith("<!--", lt)) {
      end = lower.indexOf("-->", lt + 4);
      if (end !== -1) end += 3;
    } else {
      const name = SKIPPED_ELEMENTS.exec(lower.slice(lt, lt + 8))?.[1];
      const close = name ? lower.indexOf(`</${name}`, lt + 1) : lt;
      end = close === -1 ? -1 : lower.indexOf(">", close + 1);
      if (end !== -1) end += 1;
    }
    if (end === -1) break;
    i = end;
  }
  return out.slice(0, max).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code =
      e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** The first message id in a References or In-Reply-To value. */
export function firstMessageId(value: string | null): string | null {
  return value?.match(/<[^<>\s]+>/)?.[0] ?? value?.trim().split(/\s+/)[0] ?? null;
}

function parse(bytes: Uint8Array): Promise<Email> {
  return PostalMime.parse(bytes, { ...PARSER_OPTIONS, attachmentEncoding: "arraybuffer" });
}

/** Parses the first SLICE_BYTES of a raw message. A truncated slice parses; limits throw. */
export async function parseSlice(slice: Uint8Array): Promise<ParsedHeaders> {
  const bytes = slice.subarray(0, SLICE_BYTES);
  let email =
    bytes.byteLength > FIRST_PASS_BYTES ? await parse(bytes.subarray(0, FIRST_PASS_BYTES)) : null;
  if (!email?.text && !email?.html) email = await parse(bytes);
  const contentType = email.headers.find((h) => h.key === "content-type")?.value ?? "";
  const source = email.text ?? (email.html ? htmlToText(email.html, TEXT_MAX * 2) : "");
  const text = source
    .slice(0, TEXT_MAX * 2)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_MAX);
  return {
    messageId: cut(email.messageId, HEADER_MAX),
    inReplyTo: cut(email.inReplyTo, HEADER_MAX),
    references: cut(email.references, HEADER_MAX * 4),
    subject: cut(email.subject, HEADER_MAX),
    from: email.from ? cut(formatAddress(email.from), HEADER_MAX) : null,
    to: addressList(email.to),
    cc: addressList(email.cc),
    date: cut(email.date, 64),
    hasAttachments:
      /^\s*multipart\/mixed\b/i.test(contentType) || email.attachments.some((a) => !a.related),
    text,
    snippet: text.slice(0, SNIPPET_MAX),
  };
}

/**
 * The thread key: the first id in References, else In-Reply-To, else the message's own
 * Message-ID, else the stored message id.
 */
export function threadKey(parsed: ParsedHeaders, id: string): string {
  return (
    firstMessageId(parsed.references) ?? firstMessageId(parsed.inReplyTo) ?? parsed.messageId ?? id
  );
}
