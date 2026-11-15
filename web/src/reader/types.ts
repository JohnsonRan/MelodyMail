/** A person or address from a parsed header. */
export type MailAddress = { name: string; address: string };

/** One MIME part that is not the body: a file or an inline image. */
export type MailPart = {
  filename: string | null;
  mimeType: string;
  disposition: string | null;
  /** Content-ID without angle brackets, lowercased; null when the part has none. */
  contentId: string | null;
  content: ArrayBuffer;
};

/** A message as the browser parser returns it (docs/M4-mailbox.md, "Reading mail"). */
export type ParsedMail = {
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  parts: MailPart[];
};
