import { useToast } from "@astryxdesign/core/Toast";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "./api";
import { errorMessage } from "./errors";

// Shapes the Worker returns for Settings > Domains, Addresses and Forwarding.

export type Domain = {
  name: string;
  receiveEnabled: boolean;
  sendEnabled: boolean;
  addressCount: number;
  createdAt: number;
};

export type Address = {
  id: number;
  localPart: string;
  domain: string;
  address: string;
  note: string;
  displayName: string;
  enabled: boolean;
  forwardOnly: boolean;
  targetIds: number[];
  lastReceivedAt: number | null;
  createdAt: number;
};

export type ForwardTarget = {
  id: number;
  email: string;
  note: string;
  addressCount: number;
  createdAt: number;
};

/**
 * Loads a settings page's data and runs its actions: `busy` names the running action so only
 * its control shows a loading state, an expired session goes to sign-in, and any other failure
 * becomes an error toast.
 */
export function useSettingsPage<T>(load: () => Promise<T>) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<T | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Guards against a second action (key repeat, double click) before busy re-renders.
  const running = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const handleError = useCallback(
    async (err: unknown) => {
      if (err instanceof ApiError && err.code === "unauthorized") {
        await navigate({ to: "/login" });
        return;
      }
      toast({ body: errorMessage(t, err), type: "error" });
    },
    [navigate, t, toast],
  );

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setLoadError(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthorized") await handleError(err);
      else setLoadError(true);
    }
  }, [handleError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs one action at a time; returns true when it succeeded. */
  const act = async (name: string, action: () => Promise<void>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(name);
    try {
      await action();
      return true;
    } catch (err) {
      await handleError(err);
      return false;
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  return { data, loadError, busy, act, reload, toast, t };
}
