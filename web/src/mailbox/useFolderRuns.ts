import { useToast } from "@astryxdesign/core/Toast";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import {
  BULK_MAX,
  countMessages,
  type DeletableFolder,
  deleteMessages,
  type Flags,
  type FolderCount,
  type FolderView,
  purgeFolder,
  setFolderFlags,
} from "./api";

/** What the confirm dialog of a permanent delete asks about. */
export type DeleteRequest =
  | { kind: "selection"; total: number; ids: string[] }
  | { kind: "empty" | "whole"; total: number; count: FolderCount };

/** One step of a loop: how many it handled, the ids it deleted, and whether to call again. */
type Step = { handled: number; deleted?: string[]; more: boolean };

/**
 * A call that got no answer, or a server error, may have committed (docs/M8-mailbox-ux.md,
 * section 1); a 4xx answer is a refusal that changed nothing.
 */
const unanswered = (err: unknown) =>
  !(err instanceof ApiError) || err.status === 0 || err.status >= 500;

/**
 * The loops of a folder view: Delete forever on the selection (100 ids per call), Empty and a
 * whole-folder Delete forever (purge calls with the watermark and asOf of the count read when the
 * dialog opened, sent unchanged), and a whole-folder flag change (folder-form PATCH calls with
 * `after`). Each runs inside the list's `exclusive`, can be stopped between calls, and drops from
 * the list exactly the ids the server returned. Whole-folder mode ("select all N") holds the count
 * it was entered with, so mail that arrives later is shown but not included.
 */
export function useFolderRuns({
  view,
  eligible,
  running,
  exclusive,
  applyLocal,
  failed,
  refreshCounts,
  onDeleted,
}: {
  view: FolderView | null;
  /** Every loaded row is selected and more rows exist: "select all N" is offered. */
  eligible: boolean;
  /** The page's one-action-at-a-time guard, shared with its other actions. */
  running: RefObject<boolean>;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  applyLocal: (ids: string[], flags: "deleted") => void;
  failed: (err: unknown) => Promise<void>;
  refreshCounts: () => Promise<void>;
  /** Ids deleted forever, after each call. */
  onDeleted: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [whole, setWhole] = useState<FolderCount | null>(null);
  const [offer, setOffer] = useState<FolderCount | null>(null);
  const [request, setRequest] = useState<DeleteRequest | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [counting, setCounting] = useState(false);
  const stop = useRef(false);
  const viewKey = JSON.stringify(view);

  /** Runs `step` until it says no more, the owner stops, or a call fails. */
  const loop = useCallback(
    async (total: number, step: () => Promise<Step>) => {
      stop.current = false;
      running.current = true;
      setProgress({ done: 0, total });
      let done = 0;
      let error: unknown = null;
      await exclusive(async () => {
        try {
          for (;;) {
            const result = await step();
            done += result.handled;
            if (result.deleted && result.deleted.length > 0) {
              applyLocal(result.deleted, "deleted");
              onDeleted(result.deleted);
            }
            setProgress({ done, total });
            if (!result.more || stop.current) break;
          }
        } catch (err) {
          error = err;
        }
      });
      running.current = false;
      setProgress(null);
      setWhole(null);
      void refreshCounts();
      if (error !== null) {
        if (unanswered(error)) toast({ body: t("mail.resultUnknown"), type: "error" });
        else await failed(error);
      }
      return done;
    },
    [applyLocal, exclusive, failed, onDeleted, refreshCounts, running, t, toast],
  );

  /** Opens the confirm dialog of Empty with the count, watermark and asOf read now. */
  const askEmpty = useCallback(async () => {
    if (!view || running.current) return;
    setCounting(true);
    try {
      const count = await countMessages(view);
      setRequest({ kind: "empty", total: count.total, count });
    } catch (err) {
      await failed(err);
    } finally {
      setCounting(false);
    }
  }, [failed, running, view]);

  const askDelete = useCallback(
    (ids: string[]) => {
      if (whole) setRequest({ kind: "whole", total: whole.total, count: whole });
      else if (ids.length > 0) setRequest({ kind: "selection", total: ids.length, ids });
    },
    [whole],
  );

  const confirmDelete = useCallback(async () => {
    if (!request || !view || running.current) return;
    const folder = view.folder as DeletableFolder;
    let step: () => Promise<Step>;
    if (request.kind === "selection") {
      const ids = request.ids;
      let offset = 0;
      step = async () => {
        const { deleted } = await deleteMessages(folder, ids.slice(offset, offset + BULK_MAX));
        offset += BULK_MAX;
        return { handled: deleted.length, deleted, more: offset < ids.length };
      };
    } else {
      const count = request.count;
      step = async () => {
        const { deleted, hasMore } = await purgeFolder({ ...view, folder }, count);
        return { handled: deleted.length, deleted, more: hasMore };
      };
    }
    const done = await loop(request.total, step);
    setRequest(null);
    if (done > 0) toast({ body: t("mail.done.deleted", { count: done }) });
  }, [loop, request, running, t, toast, view]);

  /** Closes the dialog; a running loop stops after the call in flight. */
  const cancelDelete = useCallback(() => {
    stop.current = true;
    setRequest(null);
  }, []);

  /** A flag change on every message of whole-folder mode; resolves to the count changed. */
  const changeWhole = useCallback(
    async (flags: Flags): Promise<number> => {
      if (!whole || !view || running.current) return 0;
      const count = whole;
      let after: number | null = null;
      return loop(count.total, async () => {
        const { updated, next } = await setFolderFlags(view, count.watermark, after, flags);
        after = next;
        return { handled: updated, more: next !== null };
      });
    },
    [loop, running, view, whole],
  );

  // The count behind "select all N", read when the offer appears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey stands for view.
  useEffect(() => {
    setOffer(null);
    if (!eligible || !view || whole) return;
    let live = true;
    countMessages(view)
      .then((count) => live && setOffer(count))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [eligible, viewKey, whole]);

  /** Leaves whole-folder mode and stops a running loop; the list starts again. */
  const reset = useCallback(() => {
    stop.current = true;
    setWhole(null);
    setOffer(null);
  }, []);

  return {
    whole,
    offer,
    request,
    progress,
    counting,
    looping: progress !== null,
    selectWhole: () => offer && setWhole(offer),
    leaveWhole: () => setWhole(null),
    stopLoop: () => {
      stop.current = true;
    },
    askEmpty,
    askDelete,
    confirmDelete,
    cancelDelete,
    changeWhole,
    reset,
  };
}
