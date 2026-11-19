import { type PointerEvent, useRef, useState } from "react";
import type { SwipeSide } from "./actions";

// A row's touch gestures on a phone: a long press selects, a horizontal swipe acts. Both start on
// pointerdown and one touch belongs to one of them (docs/M8-mailbox-ux.md, sections 3 and 5):
//  - movement over MOVE_SLOP, pointerup and pointercancel (native scrolling took the touch) clear
//    the long-press timer;
//  - a horizontal move (|dx| > |dy| and |dx| > MOVE_SLOP) belongs to the swipe, a vertical one to
//    the browser, which scrolls and then cancels the pointer;
//  - a long press that fired ends the touch, so the same touch never swipes or opens the row.
export const LONG_PRESS_MS = 500;
export const MOVE_SLOP = 10;
/** The share of the row's width past which a swipe is armed. */
export const ARM_RATIO = 0.4;
// A slide that never reports its end must not leave the row off screen.
const SLIDE_FALLBACK_MS = 400;

/** What a swiped row shows behind it: where, which side is revealed, and whether release acts. */
export type SwipeView = {
  top: number;
  height: number;
  side: SwipeSide;
  action: string;
  armed: boolean;
};

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
  /** "pending" until the touch settles into one gesture; the others end it. */
  mode: "pending" | "swipe" | "done";
  row: HTMLElement;
  width: number;
  action: string | null;
  armed: boolean;
  side: SwipeSide;
};

export type SwipeOptions<T> = {
  /** The action a swipe to `side` runs on this row, or null when that side does nothing. */
  actionFor: (item: T, side: SwipeSide) => string | null;
  /** Runs it; true when it succeeded. */
  run: (item: T, action: string) => Promise<boolean>;
  /** Reduced motion: no slide, the row is released at once. */
  reduceMotion: boolean;
  /** The element the backdrop is positioned in. */
  host: { current: HTMLElement | null };
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

const same = (a: SwipeView | null, b: SwipeView | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.top === b.top &&
    a.height === b.height &&
    a.side === b.side &&
    a.action === b.action &&
    a.armed === b.armed);

/**
 * `gestures` keeps its identity across renders, so a table plugin built from it is not rebuilt;
 * its handlers read the latest options. `view` is the swipe backdrop to draw, null when none.
 */
export function useRowGestures<T>(opts: {
  enabled: boolean;
  onLongPress: (item: T) => void;
  swipe?: SwipeOptions<T>;
}): { gestures: RowGestures<T>; view: SwipeView | null } {
  const [view, setView] = useState<SwipeView | null>(null);
  const options = useRef(opts);
  options.current = opts;
  const api = useRef<RowGestures<T> | null>(null);

  if (!api.current) {
    const touch: { current: Touch | null } = { current: null };
    const swallow = { current: false };

    const show = (next: SwipeView | null) => setView((prev) => (same(prev, next) ? prev : next));

    const clearTimer = () => {
      if (touch.current?.timer) clearTimeout(touch.current.timer);
      if (touch.current) touch.current.timer = null;
    };

    const release = (row: HTMLElement) => {
      row.style.transition = "";
      row.style.transform = "";
      row.style.backgroundColor = "";
      show(null);
    };

    /** Moves the row to `to` over the fast duration; `done` runs once when it gets there. */
    const slide = (row: HTMLElement, to: string, done: () => void) => {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        row.removeEventListener("transitionend", end);
        done();
      };
      row.style.transition = "transform var(--duration-fast) var(--ease-move)";
      row.style.transform = to;
      row.addEventListener("transitionend", end);
      setTimeout(end, SLIDE_FALLBACK_MS);
    };

    const springBack = (row: HTMLElement) => {
      if (options.current.swipe?.reduceMotion) release(row);
      else slide(row, "translateX(0)", () => release(row));
    };

    const commit = (item: T, current: Touch) => {
      const swipe = options.current.swipe;
      const action = current.action;
      if (!swipe || !action) return springBack(current.row);
      // A row that stays (the folder still holds it) comes back; a removed one is gone.
      const run = async () => {
        await swipe.run(item, action);
        springBack(current.row);
      };
      if (swipe.reduceMotion) {
        release(current.row);
        void swipe.run(item, action);
      } else {
        const sign = current.side === "right" ? 1 : -1;
        slide(current.row, `translateX(${sign * current.width}px)`, () => void run());
      }
    };

    api.current = {
      bind: (item) => ({
        onPointerDown: (event) => {
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
          const row = event.currentTarget;
          const current: Touch = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            timer: null,
            mode: "pending",
            row,
            width: row.getBoundingClientRect().width,
            action: null,
            armed: false,
            side: "right",
          };
          current.timer = setTimeout(() => {
            current.timer = null;
            if (current.mode !== "pending") return;
            current.mode = "done";
            swallow.current = true;
            options.current.onLongPress(item);
          }, LONG_PRESS_MS);
          touch.current = current;
        },
        onPointerMove: (event) => {
          const current = touch.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          const swipe = options.current.swipe;
          if (current.mode === "pending") {
            if (Math.hypot(dx, dy) <= MOVE_SLOP) return;
            clearTimer();
            const horizontal = Math.abs(dx) > MOVE_SLOP && Math.abs(dx) > Math.abs(dy);
            if (!horizontal || !swipe) {
              // Vertical, or no swipe here: the browser scrolls and then cancels the pointer.
              if (Math.abs(dy) > MOVE_SLOP || Math.abs(dx) > MOVE_SLOP) current.mode = "done";
              return;
            }
            current.mode = "swipe";
            current.row.setPointerCapture(event.pointerId);
            current.row.style.transition = "none";
            current.row.style.backgroundColor = "var(--color-background-body)";
          }
          if (current.mode !== "swipe" || !swipe) return;
          const side: SwipeSide = dx >= 0 ? "right" : "left";
          const action = swipe.actionFor(item, side);
          const offset = action ? Math.max(-current.width, Math.min(current.width, dx)) : 0;
          const armed = action !== null && Math.abs(offset) >= ARM_RATIO * current.width;
          current.row.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
          current.action = action;
          current.armed = armed;
          current.side = side;
          const host = swipe.host.current?.getBoundingClientRect();
          const box = current.row.getBoundingClientRect();
          show(
            action && host
              ? { top: box.top - host.top, height: box.height, side, action, armed }
              : null,
          );
        },
        onPointerUp: (event) => {
          const current = touch.current;
          if (current?.pointerId !== event.pointerId) return;
          clearTimer();
          touch.current = null;
          if (current.mode !== "swipe") return;
          // The finger moved a row: the click that may follow must not open it.
          swallow.current = true;
          if (current.armed) commit(item, current);
          else springBack(current.row);
        },
        onPointerCancel: (event) => {
          const current = touch.current;
          if (current?.pointerId !== event.pointerId) return;
          clearTimer();
          touch.current = null;
          if (current.mode === "swipe") springBack(current.row);
        },
        // A long press opens the system menu on Android; the row owns it instead.
        onContextMenu: (event) => {
          if (options.current.enabled) event.preventDefault();
        },
      }),
      swallowClick: () => {
        const was = swallow.current;
        swallow.current = false;
        return was;
      },
    };
  }

  return { gestures: api.current, view };
}
