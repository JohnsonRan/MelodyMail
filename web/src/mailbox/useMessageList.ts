import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { belongs, withFlags } from "./actions";
import {
  type Flags,
  getMessage,
  type ListQuery,
  listMessages,
  type MessageItem,
  type MessagePage,
} from "./api";
import { useMailbox } from "./MailboxContext";

export type ListState = {
  items: MessageItem[];
  next: string | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
};

/** Waits before each retry of a failed re-read of a filed message. */
const RETRY_MS = [1000, 2000, 4000];

const LOADING: ListState = { items: [], next: null, status: "loading", loadingMore: false };

/**
 * The messages of one list view: the first page when the query changes, the next page when the
 * sentinel scrolls into view, new mail on top when the Hub sends an event, and local updates
 * after an action. `onReset` runs whenever the list starts again from its first page.
 *
 * Every fetch remembers the generation it began in, and its answer is dropped when the generation
 * has moved since. `exclusive` runs a delete or folder loop: it moves the generation at its start
 * and its end, starts no fetch in between (scroll paging and Hub refreshes wait), and reloads the
 * first page once at the end, so no page read before or during the loop brings deleted or moved
 * rows back (docs/M8-mailbox-ux.md, section 1). A `filed` event also moves the generation, to drop
 * pages that may still hold the filed message; the re-read of that message checks `view` instead,
 * which only `reload` and `exclusive` move, so a second event does not cancel the first one's.
 * A failed re-read is retried after 1, 2 and 4 s while `view` has not moved; after the last
 * failure the row stays until the next event or a reload.
 */
export function useMessageList(
  query: ListQuery,
  failed: (err: unknown) => Promise<void>,
  onReset: () => void,
) {
  const { onMail } = useMailbox();
  const [list, setList] = useState<ListState>(LOADING);
  const loading = useRef(true);
  loading.current = list.status === "loading";
  const sentinel = useRef<HTMLElement>(null);
  const queryKey = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const resetRef = useRef(onReset);
  resetRef.current = onReset;
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const generation = useRef(0);
  const view = useRef(0);
  const paused = useRef(false);

  /** A page of the current view, or null when the generation moved while it loaded. */
  const fetchPage = useCallback(async (cursor?: string | null): Promise<MessagePage | null> => {
    const started = generation.current;
    try {
      const page = await listMessages(queryRef.current, cursor);
      return started === generation.current ? page : null;
    } catch (err) {
      if (started !== generation.current) return null;
      throw err;
    }
  }, []);

  /** A failed first page: sign-in lost, or the error state unless rows are shown. */
  const fail = useCallback(async (err: unknown) => {
    if (err instanceof ApiError && err.code === "unauthorized") await failedRef.current(err);
    else setList((prev) => (prev.status === "ready" ? prev : { ...LOADING, status: "error" }));
  }, []);

  /** The first page in place of the list, without the skeleton when rows are shown. */
  const fill = useCallback(async () => {
    try {
      const page = await fetchPage();
      if (page) {
        setList({
          items: page.messages,
          next: page.nextCursor,
          status: "ready",
          loadingMore: false,
        });
      }
    } catch (err) {
      await fail(err);
    }
  }, [fail, fetchPage]);

  const reload = useCallback(async () => {
    generation.current++;
    view.current++;
    setList(LOADING);
    resetRef.current();
    // A loop's last step reloads; nothing is fetched while it runs.
    if (!paused.current) await fill();
  }, [fill]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey is the trigger.
  useEffect(() => {
    void reload();
  }, [queryKey, reload]);

  const exclusive = useCallback(
    async <T>(work: () => Promise<T>): Promise<T> => {
      paused.current = true;
      generation.current++;
      view.current++;
      try {
        return await work();
      } finally {
        paused.current = false;
        generation.current++;
        await fill();
      }
    },
    [fill],
  );

  const loadMore = useCallback(async () => {
    if (paused.current || list.status !== "ready" || !list.next || list.loadingMore) return;
    const cursor = list.next;
    setList((prev) => ({ ...prev, loadingMore: true }));
    // A dropped page leaves the cursor in place; the sentinel then asks for it again.
    const drop = () =>
      setList((prev) => (prev.next === cursor ? { ...prev, loadingMore: false } : prev));
    try {
      const page = await fetchPage(cursor);
      if (!page) return drop();
      setList((prev) => {
        const known = new Set(prev.items.map((m) => m.id));
        return {
          ...prev,
          items: [...prev.items, ...page.messages.filter((m) => !known.has(m.id))],
          next: page.nextCursor,
          loadingMore: false,
        };
      });
    } catch (err) {
      drop();
      await failedRef.current(err);
    }
  }, [fetchPage, list.loadingMore, list.next, list.status]);

  // The next page loads when the end of the list scrolls into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !list.next) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [list.next, loadMore]);

  /** Drops a message that no longer belongs to the view, or takes its new flags. */
  const reconcile = useCallback(
    async (id: string) => {
      const started = view.current;
      let fresh: MessageItem | null = null;
      for (let retry = 0; ; retry++) {
        try {
          fresh = (await getMessage(id)).message;
          break;
        } catch (err) {
          if (err instanceof ApiError && err.code === "not_found") break;
          // After the last retry the view loads again: a refreshed first page keeps rows it does
          // not hold, so only a reload drops the filed row.
          const wait = RETRY_MS[retry];
          if (wait === undefined) {
            if (started === view.current) void reload();
            return;
          }
          await new Promise((done) => setTimeout(done, wait));
          if (started !== view.current) return;
        }
      }
      if (started !== view.current) return;
      setList((prev) => ({
        ...prev,
        items: prev.items.flatMap((m) => {
          if (m.id !== id) return [m];
          return fresh && belongs(fresh, queryRef.current) ? [{ ...m, ...fresh }] : [];
        }),
      }));
    },
    [reload],
  );

  // New mail or a changed sent message: the first page is fetched again, its new messages go on
  // top and the ones already shown take their new status. "filed" (the consumer moved new mail
  // into Spam) also discards the pages in flight, which may still hold the message, and reads
  // the message itself, since a refreshed first page does not remove a row. When that discards
  // the first page of a load, the event's own page fills the list in its place.
  useEffect(
    () =>
      onMail((event) => {
        if (paused.current) return;
        if (event.type === "filed") {
          generation.current++;
          void reconcile(event.id);
        }
        fetchPage()
          .then((page) => {
            if (!page) return;
            setList((prev) => {
              // A load whose first page was discarded, or an error an earlier event's failed
              // refresh set during that load: this page completes it.
              if (prev.status !== "ready") {
                return {
                  items: page.messages,
                  next: page.nextCursor,
                  status: "ready",
                  loadingMore: false,
                };
              }
              const known = new Set(prev.items.map((m) => m.id));
              const byId = new Map(page.messages.map((m) => [m.id, m]));
              const fresh = page.messages.filter((m) => !known.has(m.id));
              const updated = prev.items.map((m) => byId.get(m.id) ?? m);
              return { ...prev, items: [...fresh, ...updated] };
            });
          })
          .catch((err) => (loading.current ? fail(err) : undefined));
      }),
    [fail, fetchPage, onMail, reconcile],
  );

  /** Applies changed flags locally; messages that leave the view are removed. */
  const applyLocal = useCallback((ids: string[], flags: Flags | "deleted") => {
    const set = new Set(ids);
    setList((prev) => ({
      ...prev,
      items: prev.items
        .map((m) => (set.has(m.id) && flags !== "deleted" ? withFlags(m, flags) : m))
        .filter((m) => !(set.has(m.id) && (flags === "deleted" || !belongs(m, queryRef.current)))),
    }));
  }, []);

  return { list, reload, applyLocal, exclusive, sentinel };
}
