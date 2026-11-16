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
import type { Address } from "../settings";
import { type Counts, getCounts } from "./api";

// Mailbox state shared by the shell and the mailbox pages: unread counts, the address list and
// the real-time event socket (docs/M4-mailbox.md, "Real-time push").

/** Close code the Hub sends when the session ended (worker/src/mail/hub.ts). */
const SESSION_ENDED = 4001;
const PING_MS = 50_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

type MailEvent = { type: "message"; id: string };

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
    return () => {
      stopped = true;
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
    void refreshCounts();
    api<{ addresses: Address[] }>("GET", "/addresses")
      .then((data) => setAddresses(data.addresses))
      .catch(() => setAddresses([]));
  }, [refreshCounts]);

  useEventSocket((event) => {
    void refreshCounts();
    void notifyWhenHidden(event.id);
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
