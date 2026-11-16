import { useNavigate, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useCallback } from "react";
import { ListSkeleton } from "../mailbox/ListBody";
import type { SourceKind } from "./api";

// Compose lives in the URL of the mailbox page it opens on: `compose` names the draft, `src` and
// `kind` the message replied to or forwarded. Back closes it; a reload reopens the same draft.

// The compose chunk carries the Markdown renderer; first paint does not load it.
const ComposeView = lazy(() => import("./ComposeView"));

const KINDS: SourceKind[] = ["reply", "replyAll", "forward"];

export type ComposeSource = { id: string; kind: SourceKind };

export function useComposeRoute() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({
    select: (s) => s.location.search as Record<string, unknown>,
  }) as Record<string, unknown>;
  const composeId = typeof search.compose === "string" ? search.compose : null;
  const kind = KINDS.find((k) => k === search.kind);
  const source: ComposeSource | null =
    composeId && kind && typeof search.src === "string" ? { id: search.src, kind } : null;

  const keep = useCallback(() => {
    const kept: Record<string, string> = {};
    for (const k of ["m", "q"]) if (typeof search[k] === "string") kept[k] = search[k] as string;
    return kept;
  }, [search]);

  /** Opens a new compose session, or an existing draft. */
  const open = useCallback(
    (from?: ComposeSource, draftId: string = crypto.randomUUID()) => {
      const next = {
        ...keep(),
        compose: draftId,
        ...(from ? { src: from.id, kind: from.kind } : {}),
      };
      void navigate({ to: pathname as "/", search: next as never });
    },
    [keep, navigate, pathname],
  );

  const close = useCallback(() => {
    void navigate({ to: pathname as "/", search: keep() as never });
  }, [keep, navigate, pathname]);

  return { composeId, source, open, close };
}

/** The compose view, loaded with its own chunk. */
export function ComposeSlot({
  draftId,
  source,
  onClose,
  isPanel,
}: {
  draftId: string;
  source: ComposeSource | null;
  onClose: () => void;
  isPanel: boolean;
}) {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <ComposeView
        key={draftId}
        draftId={draftId}
        source={source}
        onClose={onClose}
        isPanel={isPanel}
      />
    </Suspense>
  );
}
