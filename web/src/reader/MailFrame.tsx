import { useMemo } from "react";
import { frameSrcdoc, SANDBOX } from "./sanitize";

// The sandboxed frame for sender HTML (docs/M4-mailbox.md, "Reading mail", 3). The parent cannot
// read the height of a document in an opaque-origin frame, and allow-same-origin must never be
// added to make it readable, so the frame has a fixed height and scrolls inside.

const FRAME_STYLE = {
  width: "100%",
  height: "70dvh",
  border: "var(--border-width) solid var(--color-border)",
  borderRadius: "var(--radius-container)",
  background: "white",
} as const;

export function MailFrame({
  html,
  remoteImages,
  title,
}: {
  /** Already sanitized by sanitizeMailHtml. */
  html: string;
  remoteImages: boolean;
  title: string;
}) {
  const srcdoc = useMemo(() => frameSrcdoc(html, remoteImages), [html, remoteImages]);
  return (
    <iframe
      title={title}
      sandbox={SANDBOX}
      srcDoc={srcdoc}
      referrerPolicy="no-referrer"
      style={FRAME_STYLE}
    />
  );
}
