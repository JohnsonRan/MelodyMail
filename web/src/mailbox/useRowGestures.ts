import { type PointerEvent, useRef } from "react";

// A row's touch gestures on a phone: a long press selects, a horizontal swipe acts. Both start on
// pointerdown and one touch belongs to one of them (docs/M8-mailbox-ux.md, section 5):
//  - movement over MOVE_SLOP, pointerup and pointercancel (native scrolling took the touch) clear
//    the long-press timer;
//  - a long press that fired ends the touch, so the same touch never swipes or opens the row.
export const LONG_PRESS_MS = 500;
export const MOVE_SLOP = 10;

// Clicks and keys that start inside another control in the row (the selection checkbox) are not
// the row's own.
export const INTERACTIVE = "input, button, a, label, [role='checkbox'], [data-select-cell]";

export function isRowItself(event: { target: EventTarget | null; currentTarget: EventTarget }) {
  const control = (event.target as Element | null)?.closest(INTERACTIVE);
  return !control || control === event.currentTarget;
}

type Touch = {
  pointerId: number;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** "pending" until the touch settles into one gesture; "done" ends it. */
  state: "pending" | "done";
};

export type RowGestures<T> = {
  /** Pointer handlers for the row of `item`. */
  bind: (item: T) => {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onContextMenu: (event: { preventDefault: () => void }) => void;
  };
  /** True once after a gesture that must not also open the row; call from the row's click. */
  swallowClick: () => boolean;
};

export function useRowGestures<T>({
  enabled,
  onLongPress,
}: {
  enabled: boolean;
  onLongPress: (item: T) => void;
}): RowGestures<T> {
  const touch = useRef<Touch | null>(null);
  const swallow = useRef(false);
  // The result keeps its identity, so a table plugin built from it is not rebuilt on every
  // render; the handlers read the latest options from here.
  const options = useRef({ enabled, onLongPress });
  const api = useRef<RowGestures<T> | null>(null);
  options.current = { enabled, onLongPress };

  const clearTimer = () => {
    if (touch.current?.timer) clearTimeout(touch.current.timer);
    if (touch.current) touch.current.timer = null;
  };

  const bind = (item: T) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      clearTimer();
      touch.current = null;
      swallow.current = false;
      if (
        !options.current.enabled ||
        event.pointerType === "mouse" ||
        !event.isPrimary ||
        !isRowItself(event)
      )
        return;
      const current: Touch = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer: null,
        state: "pending",
      };
      current.timer = setTimeout(() => {
        current.timer = null;
        if (current.state !== "pending") return;
        current.state = "done";
        swallow.current = true;
        options.current.onLongPress(item);
      }, LONG_PRESS_MS);
      touch.current = current;
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = touch.current;
      if (!current || current.pointerId !== event.pointerId || current.state !== "pending") return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (Math.hypot(dx, dy) > MOVE_SLOP) clearTimer();
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (touch.current?.pointerId !== event.pointerId) return;
      clearTimer();
      touch.current = null;
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (touch.current?.pointerId !== event.pointerId) return;
      clearTimer();
      touch.current = null;
    },
    // A long press opens the system menu on Android; the row owns it instead.
    onContextMenu: (event: { preventDefault: () => void }) => {
      if (options.current.enabled) event.preventDefault();
    },
  });

  const swallowClick = () => {
    const was = swallow.current;
    swallow.current = false;
    return was;
  };

  api.current ??= { bind, swallowClick };
  return api.current;
}
