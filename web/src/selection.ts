import type { CSSProperties } from "react";

// A drag selects only content (owner request 2026-11-16). The root turns selection off for the
// whole document, portals included; each region meant for copying opts back in with SELECTABLE.
// Banners, code, text inputs and text areas opt in through the melody theme. Safari needs the
// prefixed property.
export const SELECTABLE: CSSProperties = { userSelect: "text", WebkitUserSelect: "text" };

/** Called once by the root layout, before first paint. */
export function disableChromeSelection() {
  const style = document.documentElement.style;
  style.userSelect = "none";
  style.setProperty("-webkit-user-select", "none");
}
