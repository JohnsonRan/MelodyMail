import type { MailPart } from "./types";

// Attachments are only ever downloaded (docs/M4-mailbox.md, "Reading mail", 4). A blob: URL of
// a text/html or image/svg+xml part opened in a tab would run in the app's origin and could call
// the API, so the Blob is always application/octet-stream and goes through <a download>.

const RESERVED = /[<>:"/\\|?*]/g;
const NAME_MAX = 150;

const isControl = (ch: string) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;

/** A file name without path separators, control or reserved characters; never empty. */
export function safeFilename(name: string | null, fallback: string): string {
  const printable = [...(name ?? "")].map((ch) => (isControl(ch) ? "_" : ch)).join("");
  const cleaned = printable.replace(RESERVED, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned.slice(0, NAME_MAX) || fallback;
}

export async function downloadPart(part: MailPart, fallbackName: string): Promise<void> {
  const content = part.uploadId ? await fetchUpload(part.uploadId) : part.content;
  const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename(part.filename, fallbackName);
  a.rel = "noopener";
  a.click();
  // The click starts the download synchronously; the URL is not needed after this task.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** An attachment of a sent message, from the owner's own download route. */
async function fetchUpload(id: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/uploads/${encodeURIComponent(id)}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error("download_failed");
  return res.arrayBuffer();
}
