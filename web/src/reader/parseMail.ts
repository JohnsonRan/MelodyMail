import { ApiError } from "../api";
import type { ParsedMail } from "./types";

/** From this size on the reader shows download progress (docs/M4-mailbox.md). */
export const PROGRESS_FROM = 5 * 1024 * 1024;

/** Downloads a raw message; `onProgress` gets 0..1 for a message over PROGRESS_FROM. */
export async function fetchRaw(
  id: string,
  onProgress?: (share: number) => void,
): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(`/api/messages/${encodeURIComponent(id)}/raw`, {
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("network", 0);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(typeof data.error === "string" ? data.error : "internal", res.status);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress || total <= PROGRESS_FROM) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** Parses a raw message in a Web Worker; the buffer is transferred to it. */
export function parseMail(raw: ArrayBuffer): Promise<ParsedMail> {
  const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ ok: boolean; mail?: ParsedMail }>) => {
      worker.terminate();
      if (event.data.ok && event.data.mail) resolve(event.data.mail);
      else reject(new Error("parse_failed"));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("parse_failed"));
    };
    worker.postMessage(raw, [raw]);
  });
}
