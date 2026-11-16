import type { Address, Email } from "postal-mime";
import type { MailAddress, ParsedMail } from "./types";

function flatten(list: Address[] | Address | undefined): MailAddress[] {
  const items = list === undefined ? [] : Array.isArray(list) ? list : [list];
  return items.flatMap((a) =>
    a.group
      ? a.group.map((m) => ({ name: m.name, address: m.address }))
      : [{ name: a.name, address: a.address ?? "" }],
  );
}

/** The reader's shape of a postal-mime result (attachments parsed as ArrayBuffer). */
export function fromPostal(email: Email): ParsedMail {
  return {
    from: flatten(email.from),
    to: flatten(email.to),
    cc: flatten(email.cc),
    subject: email.subject ?? null,
    date: email.date ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    parts: email.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      disposition: a.disposition,
      contentId: a.contentId ? a.contentId.replace(/^<|>$/g, "").toLowerCase() : null,
      content: a.content as ArrayBuffer,
    })),
  };
}
