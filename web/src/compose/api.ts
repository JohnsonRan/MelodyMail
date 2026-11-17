import { ApiError, api } from "../api";
import { reportNetwork } from "../network";

// Shapes and calls of the sending API (docs/M5-sending.md, "Routes").

export type SourceKind = "reply" | "replyAll" | "forward";

/**
 * How compose starts from a message: a reply source, or "again", a sent message whose outcome is
 * unknown, sent as a new message under a new key (owner ruling 13). "again" is not a reply source.
 */
export type ComposeKind = SourceKind | "again";

export type FromAddress = { id: number; address: string; displayName: string };

export type SendSetup = { configured: boolean; attachments: boolean; addresses: FromAddress[] };

export type Quota = {
  daily: { used: number; limit: number };
  monthly: { used: number; limit: number };
  seenAt: number | null;
};

export type Attachment = { id: string; filename: string; contentType: string; size: number };

export type Draft = {
  id: string;
  addressId: number | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The Markdown source. */
  text: string;
  sourceId: string | null;
  sourceKind: SourceKind | null;
  idempotencyKey: string;
};

export type DraftSummary = Omit<Draft, "text"> & { snippet: string; updatedAt: number };

export const getSendSetup = () => api<SendSetup>("GET", "/send/from");
export const getQuota = () => api<Quota>("GET", "/send/quota");
export const listDrafts = () => api<{ drafts: DraftSummary[] }>("GET", "/drafts");

/** An address the owner sent to or received from; `name` is "" when none is known. */
export type Contact = { address: string; name: string };

export const searchContacts = (query: string) =>
  api<{ contacts: Contact[] }>("GET", `/contacts?q=${encodeURIComponent(query)}`);

export async function getDraft(
  id: string,
): Promise<(Draft & { attachments: Attachment[] }) | null> {
  try {
    const { draft } = await api<{ draft: Draft & { attachments: Attachment[] } }>(
      "GET",
      `/drafts/${encodeURIComponent(id)}`,
    );
    return draft;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export const saveDraft = ({ id, ...draft }: Draft) =>
  api("PUT", `/drafts/${encodeURIComponent(id)}`, draft);

export const deleteDraft = (id: string) => api("DELETE", `/drafts/${encodeURIComponent(id)}`);

export const deleteUpload = (id: string) => api("DELETE", `/uploads/${encodeURIComponent(id)}`);

export type SendRequest = {
  fromAddressId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  sourceId: string | null;
  sourceKind: SourceKind | null;
  uploadIds: string[];
  idempotencyKey: string;
};

export const sendMessage = (body: SendRequest) =>
  api<{ message: { id: string; status: string } }>("POST", "/messages/send", body);

/** Sends a failed message again from its stored copy, under its own key. */
export const retrySend = (idempotencyKey: string) =>
  api<{ message: { id: string; status: string } }>("POST", "/messages/send", { idempotencyKey });

/**
 * Streams one file to PUT /api/uploads. XMLHttpRequest, because fetch reports no upload
 * progress; `onProgress` gets 0..1.
 */
export function uploadFile(
  file: Blob,
  name: string,
  draftId: string,
  onProgress: (share: number) => void,
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/uploads");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-filename", encodeURIComponent(name));
    xhr.setRequestHeader("x-draft-id", draftId);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      reportNetwork(true);
      let data: { upload?: Attachment; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: handled as an internal error below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.upload) resolve(data.upload);
      else reject(new ApiError(data.error ?? "internal", xhr.status));
    };
    xhr.onerror = () => {
      reportNetwork(false);
      reject(new ApiError("network", 0));
    };
    xhr.send(file);
  });
}
