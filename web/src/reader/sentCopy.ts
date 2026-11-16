import { senderAddress, senderName } from "../mailbox/api";
import { fetchRaw } from "./parseMail";
import type { MailAddress, ParsedMail } from "./types";

// A sent message's stored copy (docs/M5-sending.md, "Data"): Resend returns no raw MIME, so the
// reader shows outbound mail from the JSON the Worker kept, not through postal-mime. Its HTML is
// the browser's own sanitized Markdown rendering and still goes through the reader's sanitizer
// and frame like any other HTML.

type StoredCopy = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  attachments: { uploadId: string; filename: string; contentType: string; size: number }[];
};

const person = (header: string): MailAddress => {
  const name = senderName(header);
  const address = senderAddress(header);
  return { name: name === address ? "" : name, address };
};

export async function fetchSentCopy(id: string): Promise<ParsedMail & { bcc: MailAddress[] }> {
  const raw = await fetchRaw(id);
  const copy = JSON.parse(new TextDecoder().decode(raw)) as StoredCopy;
  const bare = (list: string[]) => list.map((address) => ({ name: "", address }));
  return {
    from: [person(copy.from)],
    to: bare(copy.to),
    cc: bare(copy.cc),
    bcc: bare(copy.bcc),
    subject: copy.subject,
    date: null,
    text: copy.text,
    html: copy.html,
    parts: copy.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.contentType,
      disposition: "attachment",
      contentId: null,
      content: new ArrayBuffer(0),
      uploadId: a.uploadId,
      size: a.size,
    })),
  };
}
