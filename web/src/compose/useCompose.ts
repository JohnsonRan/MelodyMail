import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import {
  type Attachment,
  deleteDraft,
  deleteUpload,
  getDraft,
  getQuota,
  getSendSetup,
  type Quota,
  type SendSetup,
  type SourceKind,
  saveDraft,
  sendMessage,
  uploadFile,
} from "./api";
import { emailHtml } from "./markdown";
import { startFromSource } from "./start";

// One compose session (docs/M5-sending.md, "Screens" and "Sending"): the draft id and the
// idempotency key are fixed when it opens, so a double click, a retry and a second tab send one
// email. Autosave waits AUTOSAVE_MS after the last change, far below D1's daily write budget.

export const AUTOSAVE_MS = 2000;
const MIB = 1024 * 1024;
/** The Worker's limits (worker/src/send/validate.ts), checked here first for a clear message. */
export const FILE_MAX = 25 * MIB;
export const TOTAL_MAX = 30 * MIB;

export type Fields = {
  addressId: number | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
};

export type Entry = {
  key: string;
  filename: string;
  size: number;
  progress: number;
  upload: Attachment | null;
  error: string | null;
};

export type SaveState = "idle" | "saving" | "saved" | "error";

type Source = { id: string; kind: SourceKind };

const EMPTY: Fields = { addressId: null, to: [], cc: [], bcc: [], subject: "", text: "" };

const doneEntry = (a: Attachment): Entry => ({
  key: a.id,
  filename: a.filename,
  size: a.size,
  progress: 1,
  upload: a,
  error: null,
});

export function useCompose(options: {
  draftId: string;
  source: Source | null;
  own: string[];
  onSent: () => void;
}) {
  const { draftId, source } = options;
  const { t, i18n } = useTranslation("compose");
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [setup, setSetup] = useState<SendSetup | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [save, setSave] = useState<SaveState>("idle");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const key = useRef("");
  const kind = useRef<Source | null>(null);
  const dirty = useRef(false);
  const closed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ fields, draftId });
  latest.current = { fields, draftId };
  const opts = useRef(options);
  opts.current = options;

  /** Saves the draft when it changed, or always with `force` (Save draft). */
  const persist = useCallback(async (force = false) => {
    clearTimeout(timer.current);
    if (force) dirty.current = true;
    if (!dirty.current || closed.current) return;
    dirty.current = false;
    setSave("saving");
    const { fields: f, draftId: id } = latest.current;
    try {
      await saveDraft({
        id,
        ...f,
        sourceId: kind.current?.id ?? null,
        sourceKind: kind.current?.kind ?? null,
        idempotencyKey: key.current,
      });
      setSave("saved");
    } catch (err) {
      // Sent from another tab: this session is finished.
      if (err instanceof ApiError && err.code === "already_sent") closed.current = true;
      setSave("error");
    }
  }, []);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const addFiles = useCallback((files: { blob: Blob; name: string }[]) => {
    let total = entriesRef.current.reduce((sum, e) => sum + (e.error ? 0 : e.size), 0);
    for (const { blob, name } of files) {
      const entryKey = crypto.randomUUID();
      const entry: Entry = {
        key: entryKey,
        filename: name,
        size: blob.size,
        progress: 0,
        upload: null,
        error: null,
      };
      const update = (change: Partial<Entry>) =>
        setEntries((prev) => prev.map((e) => (e.key === entryKey ? { ...e, ...change } : e)));
      const refused =
        blob.size > FILE_MAX
          ? "file_too_large"
          : total + blob.size > TOTAL_MAX
            ? "attachments_too_large"
            : null;
      setEntries((prev) => [...prev, { ...entry, error: refused }]);
      if (refused) continue;
      total += blob.size;
      uploadFile(blob, name, latest.current.draftId, (progress) => update({ progress }))
        .then((upload) => update({ upload, progress: 1 }))
        .catch((err: unknown) =>
          update({ error: err instanceof ApiError ? err.code : "internal" }),
        );
    }
  }, []);

  // Load the draft, or start one (empty, or from the replied or forwarded message).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per draft id.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [sendSetup, draft] = await Promise.all([getSendSetup(), getDraft(draftId)]);
        getQuota()
          .then((q) => live && setQuota(q))
          .catch(() => {});
        if (!live) return;
        setSetup(sendSetup);
        if (draft) {
          key.current = draft.idempotencyKey;
          kind.current =
            draft.sourceId && draft.sourceKind
              ? { id: draft.sourceId, kind: draft.sourceKind }
              : null;
          setFields({
            addressId: draft.addressId,
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            text: draft.text,
          });
          setEntries(draft.attachments.map(doneEntry));
        } else {
          key.current = crypto.randomUUID();
          kind.current = source;
          const start: Fields = { ...EMPTY, addressId: sendSetup.addresses[0]?.id ?? null };
          if (source) {
            const started = await startFromSource({
              source,
              setup: sendSetup,
              own: opts.current.own,
              t,
              locale: i18n.language,
            });
            if (!live) return;
            Object.assign(start, started.fields);
            addFiles(started.files);
          }
          setFields(start);
          dirty.current = true;
        }
        setStatus("ready");
      } catch {
        if (live) setStatus("failed");
      }
    })();
    return () => {
      live = false;
    };
  }, [draftId]);

  // Autosave after the last change; a pending save runs when compose closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fields is the trigger.
  useEffect(() => {
    if (status !== "ready" || !dirty.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), AUTOSAVE_MS);
  }, [fields, status, persist]);
  useEffect(() => () => void persist(), [persist]);

  const change = useCallback((patch: Partial<Fields>) => {
    dirty.current = true;
    setFields((prev) => ({ ...prev, ...patch }));
  }, []);

  const removeEntry = useCallback((entry: Entry) => {
    setEntries((prev) => prev.filter((e) => e.key !== entry.key));
    if (entry.upload) void deleteUpload(entry.upload.id).catch(() => {});
  }, []);

  const busySend = useRef(false);
  const send = useCallback(async () => {
    const f = latest.current.fields;
    if (busySend.current || f.addressId === null) return;
    busySend.current = true;
    clearTimeout(timer.current);
    setSending(true);
    setSendError(null);
    try {
      await sendMessage({
        fromAddressId: f.addressId,
        to: f.to,
        cc: f.cc,
        bcc: f.bcc,
        subject: f.subject,
        text: f.text,
        html: emailHtml(f.text),
        sourceId: kind.current?.id ?? null,
        sourceKind: kind.current?.kind ?? null,
        uploadIds: entries.flatMap((e) => (e.upload ? [e.upload.id] : [])),
        idempotencyKey: key.current,
      });
      closed.current = true;
      opts.current.onSent();
    } catch (err) {
      setSendError(err);
      getQuota()
        .then(setQuota)
        .catch(() => {});
    } finally {
      busySend.current = false;
      setSending(false);
    }
  }, [entries]);

  const discard = useCallback(async () => {
    closed.current = true;
    clearTimeout(timer.current);
    for (const e of entries) if (e.upload) void deleteUpload(e.upload.id).catch(() => {});
    await deleteDraft(latest.current.draftId).catch(() => {});
  }, [entries]);

  return {
    status,
    setup,
    quota,
    fields,
    change,
    entries,
    addFiles,
    removeEntry,
    save,
    saveNow: persist,
    send,
    sending,
    sendError,
    discard,
  };
}
