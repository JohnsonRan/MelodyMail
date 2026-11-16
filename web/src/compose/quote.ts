import { senderAddress } from "../mailbox/api";
import type { MailAddress, ParsedMail } from "../reader/types";
import type { SourceKind } from "./api";

// What a reply, reply all or forward starts with (docs/M5-sending.md, "Screens"): recipients,
// the subject with "Re:" or "Fwd:" once, and the source quoted as a Markdown blockquote.

export type Prefill = { to: string[]; cc: string[]; subject: string; text: string };

export function prefixedSubject(subject: string, kind: SourceKind): string {
  if (kind === "forward") return /^\s*(fwd?|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** The text of an HTML body, read from an inert document (nothing loads or runs). */
function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export function quoted(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

const unique = (list: string[]) => {
  const seen = new Set<string>();
  return list.filter((a) => {
    const key = a.toLowerCase();
    if (!a || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const bare = (list: MailAddress[]) => list.map((a) => a.address).filter(Boolean);

export function prefill(input: {
  kind: SourceKind;
  /** The source's From header, as the list shows it. */
  from: string;
  subject: string | null;
  mail: ParsedMail | null;
  /** The owner's own addresses, left out of a reply all. */
  own: string[];
  /** "On <date>, <sender> wrote:", localized. */
  header: string;
}): Prefill {
  const { kind, mail } = input;
  const subject = prefixedSubject(input.subject ?? "", kind);
  const body = mail?.text ?? (mail?.html ? htmlText(mail.html) : "");
  const text = `\n\n${input.header}\n\n${quoted(body)}\n`;
  if (kind === "forward") return { to: [], cc: [], subject, text };
  const own = new Set(input.own.map((a) => a.toLowerCase()));
  const sender = mail?.from[0]?.address || senderAddress(input.from);
  const notOwn = (a: string) => !own.has(a.toLowerCase());
  // A reply to one's own sent message goes to its recipients, as Gmail does.
  const self = sender !== "" && !notOwn(sender);
  if (kind === "reply") {
    return { to: self ? bare(mail?.to ?? []) : [sender].filter(Boolean), cc: [], subject, text };
  }
  const to = unique([sender, ...bare(mail?.to ?? [])]).filter(notOwn);
  const cc = unique(bare(mail?.cc ?? [])).filter((a) => notOwn(a) && !to.includes(a));
  // Replying to one's own message: keep its recipients.
  return { to: to.length > 0 ? to : [sender], cc, subject, text };
}
