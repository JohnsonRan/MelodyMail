import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, getAuthState } from "../api";
import { notifyWhenHidden } from "../pwa/notifyHidden";
import { resyncSubscription } from "../pwa/push";
import type { Address } from "../settings";
import { type Counts, getCounts } from "./api";
import { inForeground, useMailNotice } from "./notice";

// Mailbox state shared by the shell and the mailbox pages: unread counts, the address list and
// the real-time event socket (docs/M4-mailbox.md, "Real-time push"). The socket also reports "fg"
// or "bg" so that the Hub stays quiet while a page is in the foreground (docs/M5c-foreground.md).

/** Close code the Hub sends when the session ended (worker/src/mail/hub.ts). */
const SESSION_ENDED = 4001;
const PING_MS = 50_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** How often the page re-checks its foreground state. Focus inside the reader's frame hides the
 * top window's blur when the owner then leaves the browser, so events alone can miss it. */
const CHECK_MS = 1_000;
/** How often a foreground page repeats "fg"; the Hub forgets a report after 75 s
 * (worker/src/mail/hub.ts, FOREGROUND_TTL_MS). */
const REFRESH_MS = 30_000;

/** "message": new inbound mail; "changed": a sent message or its delivery status. `quiet`: a page
 * is in the foreground, so no page notifies by itself. */
type MailEvent = { type: "message" | "changed"; id: string; quiet?: boolean };

type MailboxState = {
  counts: Counts | null;
  addresses: Address[];
  refreshCounts: () => Promise<void>;
  /** Calls `listener` for every event; returns the unsubscribe function. */
  onMail: (listener: (event: MailEvent) => void) => () => void;
};

const MailboxContext = createContext<MailboxState | null>(null);

export function useMailbox(): MailboxState {
  const state = useContext(MailboxContext);
  if (!state) throw new Error("useMailbox outside MailboxProvider");
  return state;
}

/** Keeps one socket open with backoff; a closed session sends the owner to sign-in. */
function useEventSocket(onEvent: (event: MailEvent) => void) {
  const navigate = useNavigate();
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    let reported: "fg" | "bg" | null = null;
    let reportedAt = 0;

    /** Sends the state when it changed, and "fg" again when the last one is REFRESH_MS old. */
    const report = () => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const state = inForeground() ? "fg" : "bg";
      const stale = state === "fg" && Date.now() - reportedAt >= REFRESH_MS;
      if (state === reported && !stale) return;
      socket.send(state);
      reported = state;
      reportedAt = Date.now();
    };

    const signIn = () => {
      stopped = true;
      void navigate({ to: "/login" });
    };

    const connect = () => {
      const url = new URL("/api/events", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        attempt = 0;
        ping = setInterval(() => ws.send("ping"), PING_MS);
        reported = null;
        report();
      };
      ws.onmessage = (message) => {
        if (message.data === "pong") return;
        try {
          handler.current(JSON.parse(String(message.data)) as MailEvent);
        } catch {
          // Not an event this page knows.
        }
      };
      ws.onclose = async (close) => {
        clearInterval(ping);
        if (stopped) return;
        if (close.code === SESSION_ENDED) return signIn();
        // A refused upgrade does not say why; a signed-out session is the case that needs action.
        if (!opened) {
          const state = await getAuthState().catch(() => null);
          if (state && !state.authenticated) return signIn();
        }
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt++;
        retry = setTimeout(connect, delay);
      };
    };

    connect();
    const check = setInterval(report, CHECK_MS);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      stopped = true;
      clearInterval(check);
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      clearInterval(ping);
      clearTimeout(retry);
      socket?.close();
    };
  }, [navigate]);
}

export function MailboxProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const listeners = useRef(new Set<(event: MailEvent) => void>());

  const refreshCounts = useCallback(async () => {
    try {
      setCounts(await getCounts());
    } catch {
      // The counts are a hint; the next event or action tries again.
    }
  }, []);

  useEffect(() => {
    void resyncSubscription();
    void refreshCounts();
    api<{ addresses: Address[] }>("GET", "/addresses")
      .then((data) => setAddresses(data.addresses))
      .catch(() => setAddresses([]));
  }, [refreshCounts]);

  const showNotice = useMailNotice();
  useEventSocket((event) => {
    void refreshCounts();
    if (event.type === "message") {
      if (inForeground()) void showNotice(event.id);
      else if (!event.quiet) void notifyWhenHidden(event.id);
    }
    for (const listener of listeners.current) listener(event);
  });

  const value = useMemo<MailboxState>(
    () => ({
      counts,
      addresses,
      refreshCounts,
      onMail: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [counts, addresses, refreshCounts],
  );
  return <MailboxContext.Provider value={value}>{children}</MailboxContext.Provider>;
}
