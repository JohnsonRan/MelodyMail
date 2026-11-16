import type { TFunction } from "i18next";
import { ApiError } from "../api";
import { getMessage } from "../mailbox/api";
import { formatFullDate } from "../mailbox/format";
import { fetchRaw, parseMail } from "../reader/parseMail";
import { fetchSentCopy } from "../reader/sentCopy";
import type { MailPart } from "../reader/types";
import type { SendSetup, SourceKind } from "./api";
import { type Prefill, prefill } from "./quote";

// A reply, reply all or forward starts from its source message (docs/M5-sending.md, "Screens"):
// inbound mail is parsed from its raw MIME, sent mail read from its stored copy. A forward
// brings the source's attachments along, uploaded again from the browser's copy.

/** The source message's parsed content: raw MIME for inbound, the stored copy for sent mail. */
async function loadSource(id: string) {
  const { message } = await getMessage(id);
  const mail =
    message.direction === "out" ? await fetchSentCopy(id) : await parseMail(await fetchRaw(id));
  return { message, mail };
}

async function partBlob(part: MailPart): Promise<Blob> {
  if (!part.uploadId) return new Blob([part.content], { type: part.mimeType });
  const res = await fetch(`/api/uploads/${encodeURIComponent(part.uploadId)}`);
  if (!res.ok) throw new ApiError("internal", res.status);
  return res.blob();
}

export async function startFromSource(options: {
  source: { id: string; kind: SourceKind };
  setup: SendSetup;
  own: string[];
  /** The compose namespace's t, for the quote header. */
  t: TFunction;
  locale: string;
}): Promise<{
  fields: Prefill & { addressId: number | null };
  files: { blob: Blob; name: string }[];
}> {
  const { source, setup } = options;
  const { message, mail } = await loadSource(source.id);
  const sender = mail.from[0]?.name || mail.from[0]?.address || message.from;
  const header = options.t("quoteHeader", {
    date: formatFullDate(message.receivedAt, options.locale),
    sender,
  });
  const filled = prefill({
    kind: source.kind,
    from: message.from,
    subject: message.subject,
    mail,
    own: options.own,
    header,
  });
  // Reply from the address the message arrived at, when it can send.
  const arrived = setup.addresses.find((a) => a.id === message.addressId);
  const fields = { ...filled, addressId: arrived?.id ?? setup.addresses[0]?.id ?? null };
  if (source.kind !== "forward" || !setup.attachments) return { fields, files: [] };
  const parts = mail.parts.filter((p) => p.disposition !== "inline" || !p.contentId);
  const blobs = await Promise.all(parts.map(partBlob));
  return {
    fields,
    files: blobs.map((blob, i) => ({ blob, name: parts[i]?.filename ?? "attachment" })),
  };
}
