import PostalMime from "postal-mime";
import { downloadPart } from "../src/reader/download";
import { fromPostal } from "../src/reader/fromPostal";
import { frameSrcdoc, SANDBOX, sanitizeMailHtml } from "../src/reader/sanitize";
import type { MailPart } from "../src/reader/types";

// The page the rendering-security suite drives: it runs the reader's real sanitizer and frame
// document in Chromium, with each layer switchable so a test can prove one layer on its own.

export type Layers = { sandbox: boolean; csp: boolean; sanitize: boolean };

export type RenderInput = {
  html?: string;
  eml?: string;
  remoteImages?: boolean;
  darkReading?: boolean;
  layers?: Partial<Layers>;
};

export type RenderResult = {
  sanitized: string;
  srcdoc: string;
  sandbox: string | null;
  hasRemoteContent: boolean | null;
  usedContentIds: string[];
  parts: { filename: string | null; mimeType: string; size: number }[];
};

declare global {
  interface Window {
    /** Messages a frame posted to this page: proof that sender script ran. */
    posted: string[];
    renderMail(input: RenderInput): Promise<RenderResult>;
    downloadPart(index: number): void;
  }
}

let lastParts: MailPart[] = [];
window.posted = [];
window.addEventListener("message", (event) => {
  window.posted.push(String(event.data));
});

window.renderMail = async (input) => {
  const layers: Layers = { sandbox: true, csp: true, sanitize: true, ...input.layers };
  const remoteImages = input.remoteImages ?? false;
  let html = input.html ?? "";
  let parts: MailPart[] = [];
  if (input.eml !== undefined) {
    const mail = fromPostal(
      await PostalMime.parse(input.eml, { attachmentEncoding: "arraybuffer" }),
    );
    html = mail.html ?? "";
    parts = mail.parts;
  }
  lastParts = parts;
  const clean = layers.sanitize
    ? sanitizeMailHtml(html, { parts, remoteImages, tooLargeLabel: "image too large" })
    : null;
  const body = clean ? clean.html : html;
  const srcdoc = layers.csp
    ? frameSrcdoc(body, remoteImages, input.darkReading)
    : `<!doctype html><html><head></head><body>${body}</body></html>`;
  const frame = document.createElement("iframe");
  if (layers.sandbox) frame.setAttribute("sandbox", SANDBOX);
  frame.srcdoc = srcdoc;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  await loaded;
  return {
    sanitized: body,
    srcdoc,
    sandbox: frame.getAttribute("sandbox"),
    hasRemoteContent: clean ? clean.hasRemoteContent : null,
    usedContentIds: clean ? [...clean.usedContentIds] : [],
    parts: parts.map((p) => ({
      filename: p.filename,
      mimeType: p.mimeType,
      size: p.content.byteLength,
    })),
  };
};

window.downloadPart = (index) => {
  const part = lastParts[index];
  if (part) downloadPart(part, "attachment");
};
