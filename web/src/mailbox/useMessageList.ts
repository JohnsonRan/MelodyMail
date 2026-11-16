import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { belongs } from "./actions";
import { type Flags, type ListQuery, listMessages, type MessageItem } from "./api";
import { useMailbox } from "./MailboxContext";

export type ListState = {
  items: MessageItem[];
  next: string | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
};

const LOADING: ListState = { items: [], next: null, status: "loading", loadingMore: false };

/**
 * The messages of one list view: the first page when the query changes, the next page when the
 * sentinel scrolls into view, new mail on top when the Hub sends an event, and local updates
 * after an action. `onReset` runs whenever the list starts again from its first page.
 */
export function useMessageList(
  query: ListQuery,
  failed: (err: unknown) => Promise<void>,
  onReset: () => void,
) {
  const { onMail } = useMailbox();
  const [list, setList] = useState<ListState>(LOADING);
  const sentinel = useRef<HTMLElement>(null);
  const queryKey = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const resetRef = useRef(onReset);
  resetRef.current = onReset;

  const reload = useCallback(async () => {
    setList(LOADING);
    resetRef.current();
    try {
      const page = await listMessages(queryRef.current);
      setList({ items: page.messages, next: page.nextCursor, status: "ready", loadingMore: false });
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthorized") await failed(err);
      else setList({ ...LOADING, status: "error" });
    }
  }, [failed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey is the trigger.
  useEffect(() => {
    void reload();
  }, [queryKey, reload]);

  const loadMore = useCallback(async () => {
    if (list.status !== "ready" || !list.next || list.loadingMore) return;
    setList((prev) => ({ ...prev, loadingMore: true }));
    try {
      const page = await listMessages(queryRef.current, list.next);
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
      setList((prev) => ({ ...prev, loadingMore: false }));
      await failed(err);
    }
  }, [failed, list.loadingMore, list.next, list.status]);

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

  // New mail or a changed sent message: the first page is fetched again, its new messages go on
  // top and the ones already shown take their new status.
  useEffect(
    () =>
      onMail(() => {
        listMessages(queryRef.current)
          .then((page) =>
            setList((prev) => {
              if (prev.status !== "ready") return prev;
              const known = new Set(prev.items.map((m) => m.id));
              const byId = new Map(page.messages.map((m) => [m.id, m]));
              const fresh = page.messages.filter((m) => !known.has(m.id));
              const updated = prev.items.map((m) => byId.get(m.id) ?? m);
              return { ...prev, items: [...fresh, ...updated] };
            }),
          )
          .catch(() => {});
      }),
    [onMail],
  );

  /** Applies changed flags locally; messages that leave the view are removed. */
  const applyLocal = useCallback((ids: string[], flags: Flags | "deleted") => {
    const set = new Set(ids);
    setList((prev) => ({
      ...prev,
      items: prev.items
        .map((m) => (set.has(m.id) && flags !== "deleted" ? { ...m, ...flags } : m))
        .filter((m) => !(set.has(m.id) && (flags === "deleted" || !belongs(m, queryRef.current)))),
    }));
  }, []);

  return { list, reload, applyLocal, sentinel };
}
