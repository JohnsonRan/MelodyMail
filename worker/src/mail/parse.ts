import PostalMime, { type Address } from "postal-mime";

/**
 * The bounded server-side parse (docs/PLAN.md, section 2, "CPU budget"): it only ever sees the
 * first SLICE_BYTES of a message, so its work does not grow with the message size. The browser
 * parses the full raw message (M4). Owner ruling (2026-11-16): one pass over 64 KB; a message
 * whose text starts later is parsed with an empty snippet and no search text.
 */
export const SLICE_BYTES = 64 * 1024;
export const TEXT_MAX = 8 * 1024;
export const SNIPPET_MAX = 200;
const HEADER_MAX = 998;
const ADDRESS_LIST_MAX = 2000;
/** The longest address SMTP carries (RFC 5321, section 4.5.3.1.3); a longer From has no key. */
const FROM_KEY_MAX = 254;

// Limits on the parser's own work inside the slice (owner ruling 2026-11-16): hundreds of parts
// or tens of KB of headers cost postal-mime more than the 3 ms budget. A message over them fails
// the parse and becomes parse_failed; the browser still reads it from the raw object.
const PARSER_OPTIONS = {
  maxNestingDepth: 32,
  maxPartCount: 50,
  maxHeadersSize: 64 * 1024,
  maxRfc822NestingDepth: 2,
};

export type ParsedHeaders = {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string | null;
  from: string | null;
  /**
   * The bare addr-spec of From, lowercased: the key spam_senders is matched on (docs/M8-mailbox-ux.md,
   * "Filing"). Taken from the structured address, not from `from`, whose cut can lose the address
   * after a long display name. Null for a group, an empty address or one over FROM_KEY_MAX.
   */
  fromKey: string | null;
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
 * script, style or head element drops the rest of the input. The text is collected in pieces and
 * joined once; the length and whether it ends in a space are kept in variables, because reading
 * back a string built with += costs more than linear time on HTML dense with short tags.
 */
function htmlToText(html: string, max: number): string {
  const lower = html.toLowerCase();
  const pieces: string[] = [];
  let length = 0;
  let endsInSpace = false;
  let i = 0;
  while (i < html.length && length < max) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pieces.push(html.slice(i));
      break;
    }
    if (lt > i) {
      pieces.push(html.slice(i, lt));
      length += lt - i;
      endsInSpace = html.charCodeAt(lt - 1) === 0x20;
    }
    if (!endsInSpace) {
      pieces.push(" ");
      length += 1;
      endsInSpace = true;
    }
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
  return pieces
    .join("")
    .slice(0, max)
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const code =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}

function fromKey(from: Address | undefined): string | null {
  const address = from?.address?.trim().toLowerCase();
  return address && address.length <= FROM_KEY_MAX ? address : null;
}

/** The first message id in a References or In-Reply-To value. */
export function firstMessageId(value: string | null): string | null {
  return value?.match(/<[^<>\s]+>/)?.[0] ?? value?.trim().split(/\s+/)[0] ?? null;
}

/** Parses the first SLICE_BYTES of a raw message. A truncated slice parses; limits throw. */
export async function parseSlice(slice: Uint8Array): Promise<ParsedHeaders> {
  const email = await PostalMime.parse(slice.subarray(0, SLICE_BYTES), {
    ...PARSER_OPTIONS,
    attachmentEncoding: "arraybuffer",
  });
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
    fromKey: fromKey(email.from),
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
